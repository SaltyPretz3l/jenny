/* renderer/chat/renderer-durable-send-pause.js -- pause requests for durable Send (UMD) */
/**
 * The pause half of the durable-send controller: which work was asked to
 * pause, whether the runtime has answered yet, and the one composer notice
 * that may say so. It never reads the runtime on its own clock; the
 * controller's poll tick calls settleAll() and its snapshot reads call
 * reconcile(), so a request is watched without a second timer.
 *
 * Honesty rules it owns: a request on a running reply is never called a
 * pause; the notice is written and cleared only in the conversation that
 * paused, through the owner-scoped notice API; a request the runtime can no
 * longer answer is dropped rather than left disabling the control forever.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.rendererDurableSendPause = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || ((_key, fallback) => fallback);
  const TERMINAL = ['completed', 'failed', 'cancelled'];
  // Pause requests are click-bounded, but nothing else ever forgets them.
  const PAUSE_REQUESTS_MAX = 32;
  // A request the runtime can no longer answer is dropped after this many
  // silent reads instead of disabling the control forever.
  const PAUSE_UNANSWERED_MAX = 3;
  const OWNER = 'runtime:pause';

  /**
   * @param {Object} deps
   * @param {Object} deps.state - Renderer state (currentSessionId)
   * @param {Object} deps.callbacks - setComposerStatusNotice, clearComposerStatusNotice?, appendClientLog?
   * @param {Function} deps.closed - True once the owning controller is disposed
   * @param {Function} deps.render - render(sessionId)
   * @param {Function} deps.refreshSessionQueue - One session-scoped snapshot read; resolves to whether it covered the session
   * @param {Function} deps.getSessionRows - sessionId -> cached snapshot rows
   * @param {Function} deps.controlDetached - (workId, owner, invoke) -> result or null after naming the refusal
   * @param {Function} deps.noticeRefusal - (source, owner)
   * @param {Function} deps.schedulePoll
   * @param {Function|null} deps.pause - payload -> runtime pause result
   * @param {Function|null} deps.getWork - payload -> runtime work read
   */
  function createPauseRequests(deps) {
    const { state, callbacks: c, closed, render, refreshSessionQueue, getSessionRows,
      controlDetached, noticeRefusal, schedulePoll, pause, getWork } = deps;
    const requests = new Map();
    function current(sessionId) { return String(state.currentSessionId || '').trim() === sessionId; }
    // A pause notice belongs to the conversation that paused, never to
    // whichever one happens to be on screen when the runtime answers.
    function notice(settled, sessionId) {
      if (!current(sessionId)) return;
      // A running reply settles only when the sidecar offers an approval
      // decision; auto-approved tool calls offer none, so the copy names the
      // approval, not "the next tool call".
      c.setComposerStatusNotice(settled
        ? jt('chat.runtimePause.settled', "Paused. Resume from the queue strip when you're ready.")
        : jt('chat.runtimePause.requested', 'Pause requested. Jenny pauses at her next approval; a reply that needs no approval finishes.'),
      { owner: OWNER, tone: settled ? 'success' : 'pending' });
    }
    // Owner-respecting: a newer notice from another owner survives the clear.
    function clear(sessionId) {
      if (!current(sessionId)) return;
      if (typeof c.clearComposerStatusNotice === 'function') c.clearComposerStatusNotice({ owner: OWNER });
      else c.setComposerStatusNotice('', { owner: OWNER });
    }
    function remember(workId, request) {
      requests.delete(workId);
      requests.set(workId, request);
      if (requests.size > PAUSE_REQUESTS_MAX) requests.delete(requests.keys().next().value);
    }
    // Resumed or discarded from the composer: the request and its notice go together.
    function forget(workId, sessionId) {
      requests.delete(workId);
      clear(sessionId);
    }
    function sessionOf(workId) { return requests.get(workId)?.sessionId || ''; }
    function watching() { return [...requests.values()].some(request => request.status === 'requested'); }
    function hasSession(sessionId) { return [...requests.values()].some(request => request.sessionId === sessionId); }
    // The composer's view: the outstanding request first, else a settled one.
    function stateFor(sessionId) {
      let found = null;
      for (const [workId, request] of requests) {
        if (request.sessionId !== sessionId) continue;
        if (!found || request.status === 'requested') found = Object.freeze({ workId, status: request.status });
      }
      return found;
    }
    // Resumed or finished work is no longer paused, so nothing may keep saying it is.
    function reconcile(sessionId, rows) {
      for (const [workId, request] of [...requests]) {
        if (request.sessionId !== sessionId || request.status !== 'paused') continue;
        const row = rows.find(item => item.work_id === workId);
        if (!row || row.status === 'paused') continue;
        forget(workId, sessionId);
      }
    }
    // Pause acts only on the reply in progress. A queued message is withdrawn
    // from the strip or paused from Settings, and a reply the runtime does not
    // own (an edit, a retry, a legacy stream) has no running row to pause.
    async function pauseSession(sessionId) {
      const id = String(sessionId || '').trim();
      if (closed() || !id || typeof pause !== 'function') return false;
      await refreshSessionQueue(id);
      if (closed()) return false;
      const target = getSessionRows(id).find(row => row.status === 'running');
      if (!target) { noticeRefusal('runtime_no_running_reply', OWNER); return false; }
      const result = await controlDetached(target.work_id, OWNER, payload => pause(payload));
      if (!result || closed()) return false;
      if (result.status === 'paused') {
        remember(target.work_id, { sessionId: id, status: 'paused' });
        await refreshSessionQueue(id);
        if (closed()) return false;
        notice(true, id);
      } else {
        // Nothing is paused yet; the runtime decides when, at its own boundary.
        remember(target.work_id, { sessionId: id, status: 'requested', unanswered: 0 });
        notice(false, id);
        schedulePoll();
      }
      render(id);
      return true;
    }
    async function settle(workId, request) {
      if (!getSessionRows(request.sessionId).some(row => row.work_id === workId && row.status === 'paused')) {
        await refreshSessionQueue(request.sessionId);
      }
      if (closed() || !requests.has(workId)) return;
      request.status = 'paused';
      notice(true, request.sessionId);
      render(request.sessionId);
    }
    // One work read per outstanding request, on the controller's own tick.
    async function settleAll() {
      if (typeof getWork !== 'function') return;
      for (const [workId, request] of [...requests]) {
        if (closed()) return;
        if (request.status !== 'requested') continue;
        let read;
        try { read = await getWork({ work_id: workId }); }
        catch (_error) { read = null; }
        if (closed()) return;
        const status = read?.ok === true ? String(read.work?.status || '') : '';
        if (status === 'paused') { request.unanswered = 0; await settle(workId, request); continue; }
        // A reply that needs no approval simply finishes: the request is moot,
        // so nothing stays on screen implying a pause is still coming.
        if (TERMINAL.includes(status)) {
          forget(workId, request.sessionId);
          render(request.sessionId);
          continue;
        }
        if (status) { request.unanswered = 0; continue; }
        // The runtime no longer answers for this work (gone, or unreachable):
        // after a few silent reads the request is dropped rather than left
        // disabling the control and re-arming the poller forever.
        request.unanswered = (request.unanswered || 0) + 1;
        if (request.unanswered < PAUSE_UNANSWERED_MAX) continue;
        c.appendClientLog?.('WARN', 'chat.turn_pause_unanswered', { work_id: workId });
        forget(workId, request.sessionId);
        render(request.sessionId);
      }
    }
    function dispose() { requests.clear(); }
    return { pauseSession, settleAll, reconcile, stateFor, forget, sessionOf, watching, hasSession, dispose };
  }

  return { createPauseRequests };
});
