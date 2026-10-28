/* renderer/features/renderer-ide-pty-terminal-io.js — the bridge side of one
 * Workspace PTY terminal panel: data/exit stream routing (slot filter and the
 * pre-ready buffer), keystroke and command writes with their caps, and kill
 * outcomes. Session state stays with the panel (renderer-ide-pty-terminal-panel.js),
 * read through the callbacks it passes in. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererIdePtyTerminalIo = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const INTERRUPT_BYTE = String.fromCharCode(3); // Ctrl+C
  // Main truncates one write() at this many UTF-8 bytes (MAX_WRITE_BYTES in
  // services/workspace-pty-service.js). A longer command would reach the shell
  // cut off and without its newline, so it is refused before anything is typed.
  const SEND_COMMAND_MAX_BYTES = 16 * 1024;

  // ctx: { slot, getApi, getSessionId, getSessionShell, getSessionCwd,
  //        isBuffering, ensureStarted, onData, onExit, terminalStreamUtils,
  //        appendClientLog, logIgnoredError }
  function createPtyTerminalIo(ctx) {
    const slot = ctx.slot;
    const getApi = ctx.getApi;
    const getSessionId = ctx.getSessionId;
    const appendClientLog = ctx.appendClientLog;
    const logIgnoredError = ctx.logIgnoredError;
    const terminalStreamUtils = ctx.terminalStreamUtils;
    let unsubscribeData = null;
    let unsubscribeExit = null;
    // UIUX-011: main can emit output/exit the instant a session is wired (spawn()
    // wires listeners synchronously before its IPC reply is sent), so events that
    // land before the renderer knows its own session id are held in the shared
    // bounded buffer (terminal-stream-utils' default caps: 64 events / 64 KiB,
    // oldest evicted, visible dropped counter) and replayed in order the moment
    // spawn resolves (AGENTS.md section 9: resource bounds + retention).
    const preReadyEvents = terminalStreamUtils.createPreReadyEventBuffer({
      sizeOf: (kind, payload) => (kind === 'data' ? String(payload?.data || '').length : 0),
      onDrop: (stats) => appendClientLog('WARN', 'ide.pty_prereadybuffer_dropped', stats),
    });

    // A best-effort bridge call whose answer nobody waits for (keystrokes, ^C).
    function fireAndForget(site, call) {
      try { Promise.resolve(call()).catch((error) => logIgnoredError(site, error)); } catch (error) { logIgnoredError(site, error); }
    }

    // With four panels sharing one bridge, an event naming ANOTHER slot is never
    // ours, even while our own session id is still unknown (pre-ready buffering).
    function isOtherSlot(payload) {
      const eventSlot = Number(payload?.slot);
      return Number.isFinite(eventSlot) && eventSlot >= 1 && eventSlot !== slot;
    }

    function routeEvent(kind, apply) {
      return (payload) => {
        if (isOtherSlot(payload)) {
          return;
        }
        if (ctx.isBuffering()) {
          preReadyEvents.push(kind, payload);
          return;
        }
        apply(payload);
      };
    }

    function subscribe(api) {
      if (!unsubscribeData && typeof api.onData === 'function') {
        unsubscribeData = api.onData(routeEvent('data', ctx.onData)) || null;
      }
      if (!unsubscribeExit && typeof api.onExit === 'function') {
        unsubscribeExit = api.onExit(routeEvent('exit', ctx.onExit)) || null;
      }
    }

    function unsubscribe() {
      try { unsubscribeData?.(); } catch (error) { logIgnoredError('unsubscribe_data', error); }
      unsubscribeData = null;
      try { unsubscribeExit?.(); } catch (error) { logIgnoredError('unsubscribe_exit', error); }
      unsubscribeExit = null;
    }

    // Replay in arrival order once sessionId is known: a buffered exit clears
    // sessionId mid-replay, so trailing data drops (never a false 'running').
    function replayPreReady() {
      preReadyEvents.replay({ data: ctx.onData, exit: ctx.onExit });
    }

    function discardPreReady() {
      preReadyEvents.discard();
    }

    // USER KEYSTROKES and sendCommand() are the only sanctioned api.write callers.
    function writeKeystrokes(data) {
      const api = getApi();
      const sessionId = getSessionId();
      if (sessionId && api && typeof api.write === 'function') {
        fireAndForget('write', () => api.write({ sessionId, data }));
      }
    }

    function sendInterrupt() {
      const api = getApi();
      const sessionId = getSessionId();
      if (!sessionId || !api || typeof api.write !== 'function') {
        return;
      }
      fireAndForget('interrupt', () => api.write({ sessionId, data: INTERRUPT_BYTE }));
    }

    async function sendCommand(commandOrBuilder) {
      try {
        if (!getSessionId() && !(await ctx.ensureStarted())) {
          return false;
        }
        const api = getApi();
        if (typeof api?.write !== 'function') {
          return false;
        }
        const command = typeof commandOrBuilder === 'function'
          ? commandOrBuilder(ctx.getSessionShell(), ctx.getSessionCwd())
          : commandOrBuilder;
        const data = `${String(command || '')}\r\n`;
        const dataBytes = new TextEncoder().encode(data).length;
        if (dataBytes > SEND_COMMAND_MAX_BYTES) {
          appendClientLog('WARN', 'ide.pty_send_command_refused', { code: 'too_long' });
          return false;
        }
        const result = await api.write({ sessionId: getSessionId(), data });
        // main answers { ok, written } or { ok: false, code }; only a complete,
        // accepted write counts as sent.
        const accepted = Boolean(result) && typeof result === 'object' && result.ok === true
          && !(Number.isFinite(result.written) && result.written < dataBytes);
        if (!accepted) {
          appendClientLog('WARN', 'ide.pty_send_command_refused', { code: String(result?.code || '') });
        }
        return accepted;
      } catch (_error) {
        return false;
      }
    }

    // Kill a session by id and resolve whether main CONFIRMED it is gone (a
    // rejected request or a terminationConfirmed:false answer is unconfirmed;
    // { killed:false } alone means nothing was left to kill).
    function killSession(id, site) {
      const api = getApi();
      if (!id || typeof api?.kill !== 'function') {
        return Promise.resolve(true);
      }
      let request;
      try { request = api.kill({ sessionId: id }); } catch (error) { request = Promise.reject(error); }
      return Promise.resolve(request).then(terminalStreamUtils.killOutcomeConfirmed, (error) => {
        logIgnoredError(site, error);
        return false;
      });
    }

    return {
      discardPreReady,
      isOtherSlot,
      killSession,
      replayPreReady,
      sendCommand,
      sendInterrupt,
      subscribe,
      unsubscribe,
      writeKeystrokes,
    };
  }

  return {
    INTERRUPT_BYTE,
    SEND_COMMAND_MAX_BYTES,
    createPtyTerminalIo,
  };
});
