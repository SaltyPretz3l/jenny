/* services/main/window-exit-guard.js
 *
 * Native-close data-loss guard (UIUX-003). The title-bar X (and any other
 * native/OS-driven BrowserWindow 'close') would otherwise destroy the renderer
 * — and with it any unsaved Workspace IDE buffers — before the renderer could
 * prompt. This guard intercepts 'close', asks the renderer to run its batched
 * dirty-buffer preflight (renderer-window-exit-preflight.js) via a one-shot
 * request/reply IPC, and only lets the window close once the renderer replies
 * proceed:true (or authorizes it out-of-band for the custom Close button).
 *
 * FAIL-OPEN CONTRACT: a hung or absent renderer (no reply within `timeoutMs`),
 * a destroyed webContents, or a failed push must NEVER strand an unclosable
 * window. In every such case we log a structured warning, set the internal
 * bypass flag, and close. An unclosable window on a wedged renderer is a worse
 * failure than the residual (rare) data-loss risk of skipping the prompt.
 *
 * app.quit()-driven shutdown is sequenced elsewhere (main lifecycle); when
 * `isAppQuitting()` is true we allow the close immediately and never prompt.
 */
const { getBridgeChannel } = require('../ipc-contract');

function createWindowExitGuard({
  getMainLifecycle = () => null,
  log = () => {},
  timeoutMs = 3000,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
} = {}) {
  const requestChannel = getBridgeChannel('window.onExitPreflightRequest', 'subscribe');

  // `bypass` is a one-shot "this next close is authorized" flag. Set by a
  // renderer proceed:true reply, by authorizeNextClose() (custom Close button),
  // and by every fail-open path. `pending` holds the single in-flight request.
  let bypass = false;
  let pending = null; // { requestId, win, timer }
  let requestSeq = 0;

  function logEvent(level, event, details) {
    try {
      log(level, event, details || {});
    } catch (_error) {
      /* logging must never change the close outcome */
    }
  }

  function isWindowUsable(win) {
    return Boolean(win) && (typeof win.isDestroyed !== 'function' || !win.isDestroyed());
  }

  function clearPending() {
    if (pending && pending.timer !== undefined && pending.timer !== null) {
      clearTimeoutFn(pending.timer);
    }
    pending = null;
  }

  function isAppQuitting() {
    try {
      const lifecycle = getMainLifecycle();
      return Boolean(
        lifecycle
        && typeof lifecycle.isAppQuitting === 'function'
        && lifecycle.isAppQuitting()
      );
    } catch (_error) {
      return false;
    }
  }

  function failOpenClose(win, reason) {
    logEvent('WARN', 'window.exit_preflight_fail_open', { reason });
    bypass = true;
    try {
      if (isWindowUsable(win) && typeof win.close === 'function') {
        win.close();
      }
    } catch (error) {
      bypass = false;
      logEvent('WARN', 'window.exit_preflight_fail_open_close_failed', {
        reason,
        message: String((error && error.message) || error || ''),
      });
    }
  }

  function handleClose(event, win) {
    // An authorized close (renderer proceed:true, custom-Close authorize, or a
    // fail-open) passes straight through, consuming the one-shot flag.
    if (bypass) {
      bypass = false;
      return;
    }
    // Shutdown is already sequenced by the main lifecycle; never prompt.
    if (isAppQuitting()) {
      return;
    }
    // In-flight guard: a second native close while one preflight is pending is
    // ignored — the first request owns the decision.
    if (pending) {
      logEvent('DEBUG', 'window.exit_preflight_in_flight', { requestId: pending.requestId });
      if (event && typeof event.preventDefault === 'function') {
        event.preventDefault();
      }
      return;
    }
    if (event && typeof event.preventDefault === 'function') {
      event.preventDefault();
    }
    const webContents = win && win.webContents;
    if (!isWindowUsable(win) || !webContents || typeof webContents.send !== 'function') {
      failOpenClose(win, 'no_webcontents');
      return;
    }
    requestSeq += 1;
    const requestId = `win-exit-${requestSeq}`;
    const timer = setTimeoutFn(() => {
      if (pending && pending.requestId === requestId) {
        pending = null;
        logEvent('WARN', 'window.exit_preflight_timeout', { requestId, timeoutMs });
        failOpenClose(win, 'timeout');
      }
    }, timeoutMs);
    pending = { requestId, win, timer };
    try {
      webContents.send(requestChannel, { requestId });
    } catch (error) {
      clearPending();
      logEvent('WARN', 'window.exit_preflight_send_failed', {
        requestId,
        message: String((error && error.message) || error || ''),
      });
      failOpenClose(win, 'send_failed');
    }
  }

  function attach(mainWindow) {
    if (!mainWindow || typeof mainWindow.on !== 'function') {
      return false;
    }
    mainWindow.on('close', (event) => handleClose(event, mainWindow));
    // A window destroyed mid-preflight (crash, external kill) must not leave a
    // dangling pending entry — and its live timeout timer — behind.
    mainWindow.on('closed', () => {
      if (pending && pending.win === mainWindow) {
        clearPending();
      }
    });
    return true;
  }

  // Renderer's answer to a pending native-close preflight. proceed:true closes
  // the window (through the bypass); proceed:false drops the pending close.
  //
  // {ack:true} is the renderer's immediate "alive, dialog coming" signal, sent
  // BEFORE the interactive Save / Don't Save / Cancel prompt. It cancels the
  // fail-open timer without consuming the pending entry: a human deliberating
  // at the dialog must never be force-closed at timeoutMs (that force-close
  // discarded the very buffers this guard protects). The timeout's job is
  // narrowed to what it can actually detect — a renderer too wedged to receive
  // the request at all. After the ack, exposure matches the custom-titlebar
  // Close path, which has no main-side timer either.
  function resolvePreflight(payload) {
    const requestId = String((payload && payload.requestId) || '');
    if (payload && payload.ack === true) {
      if (!pending || pending.requestId !== requestId) {
        return { ok: false, code: 'no_pending' };
      }
      if (pending.timer !== undefined && pending.timer !== null) {
        clearTimeoutFn(pending.timer);
        pending.timer = null;
      }
      logEvent('DEBUG', 'window.exit_preflight_acked', { requestId });
      return { ok: true, ack: true };
    }
    const proceed = Boolean(payload && payload.proceed === true);
    if (!pending || pending.requestId !== requestId) {
      return { ok: false, code: 'no_pending' };
    }
    const win = pending.win;
    clearPending();
    if (proceed) {
      bypass = true;
      try {
        if (isWindowUsable(win) && typeof win.close === 'function') {
          win.close();
        }
      } catch (error) {
        bypass = false;
        logEvent('WARN', 'window.exit_preflight_close_failed', {
          requestId,
          message: String((error && error.message) || error || ''),
        });
        return { ok: false, code: 'close_failed' };
      }
    }
    return { ok: true, proceed };
  }

  // Custom Close button path: the renderer has ALREADY run its dirty preflight
  // before invoking windowControl('close'), so the subsequent programmatic
  // mainWindow.close() must not re-prompt. The aux handler calls this
  // immediately before close().
  function authorizeNextClose() {
    bypass = true;
  }

  function isPreflightPending() {
    return Boolean(pending);
  }

  return { attach, resolvePreflight, authorizeNextClose, isPreflightPending };
}

module.exports = { createWindowExitGuard };
