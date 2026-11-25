/* renderer/chat/renderer-session-rail-jobs.js - the run rows of the session rail's Running now section (UMD).

   Owner pick 2026-11-01: run_command background jobs live in the rail (the chip strip above the composer is
   gone); row 195 moved them to "Running now". The rail controller paints the rows from the model; this helper
   owns what a row does once painted, for ONE rail tray:
     - a live row's elapsed time ticks once a second while any is on screen;
     - Stop (data-rail-job-stop) calls backgroundJobs.kill and disables itself until the next paint (a
       refused stop re-enables it and says so in its tooltip);
     - a live job other chats wait on (row 100 P2 work leases) reads "N waiting · " before its time, and
       its hover and Stop tooltip say so; getJobWaiters returns the waiting chats' titles ('' if untitled);
     - a server row's Stop (data-rail-server-stop="job:<id>") kills the job like a job Stop and "browser"
       closes the chat's browser page, each disabling itself until the next paint (a refusal re-enables it).
       The chat's browser state (browserUse.getState, then its onChanged pushes for this chat) is read here
       and handed to the rail through getBrowser; onBrowserChange asks it to repaint. While the tray is not
       shown nothing is read.
   showOutputPathMenu is shared with the Background tasks panel. Job text renders through textContent only. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./renderer-session-rail-model'));
    return;
  }
  root.rendererSessionRailJobs = factory(root.rendererSessionRailModel);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (model) {
  'use strict';

  const TICK_MS = 1000;
  const trimRoot = (value) => String(value || '').replace(/\\/g, '/').replace(/\/+$/, '');
  const sameRoot = (a, b) => (/^[A-Za-z]:/.test(a) ? a.toLowerCase() === b.toLowerCase() : a === b);

  // The shared path menu on a job's output.txt (the rail's finished row and the Background tasks panel's Open full
  // output). workspaceFs speaks workspace-relative paths, and the tracker derives fullOutputPath only as
  // <root>/.jenny/tool-results/<jobId>/output.txt, so the relative path is rebuilt from the job id. Anything else (no
  // path yet, a path of another shape, or a job captured under another workspace root than the current one, whose
  // relative path would open the wrong file) leaves the browser default. True when the menu showed.
  function showOutputPathMenu({ jobId, fullOutputPath, event, control, rootEl, win, pathMenu, workspaceRoot }) {
    const full = String(fullOutputPath || '').replace(/\\/g, '/');
    const relative = `.jenny/tool-results/${jobId}/output.txt`;
    if (!/^[0-9a-f]{12}$/.test(String(jobId || '')) || !full.endsWith(`/${relative}`) || typeof pathMenu?.showPathMenu !== 'function') return false;
    const jobRoot = trimRoot(full.slice(0, -(relative.length + 1)));
    const root = trimRoot(workspaceRoot);
    if (!root || !jobRoot || !sameRoot(jobRoot, root)) return false;
    const shown = pathMenu.showPathMenu({
      path: relative, kind: 'file', windowRef: win, anchorX: event.clientX, anchorY: event.clientY, anchorEl: control, restoreFocusTo: control, rootEl,
    });
    if (shown) event.preventDefault();
    return Boolean(shown);
  }

  function createRailJobs({ tray, win, jt, getSessionId = () => '', trayShown = () => true, getBackgroundJobs, getJobWaiters = null, getBrowserUse = () => win?.jennyShell?.browserUse, onBrowserChange = null } = {}) {
    if (!tray || !win) return { handleClick: () => false, getBrowser: () => null, syncBrowser: () => {}, dispose: () => {} };
    let ticker = 0;
    let disposed = false;
    let browser = null; // { open, url, title } while this chat's browser page is open
    let browserOff = null;
    let browserSeq = 0;

    function api() {
      try { return getBackgroundJobs() || null; } catch { return null; }
    }

    // Sets a title from the painted one (kept once); `make` gets that original and returns the new text, or null.
    function setTitle(node, make) {
      if (!node) return;
      if (!node.hasAttribute('data-rail-base-title')) node.setAttribute('data-rail-base-title', node.title || '');
      const original = node.getAttribute('data-rail-base-title');
      const text = make(original) ?? original;
      if (node.title !== text) node.title = text;
    }

    function syncWaiters() {
      if (typeof getJobWaiters !== 'function') return;
      for (const slot of tray.querySelectorAll('[data-rail-job-waiting]')) {
        let titles;
        try { titles = getJobWaiters(slot.getAttribute('data-rail-job-waiting')) || []; } catch { titles = []; }
        const count = titles.length;
        const text = count ? `${jt('chat.sessionRail.tasks.jobWaiting', '{count} waiting', { count })} · ` : '';
        if (slot.textContent !== text) slot.textContent = text;
        const named = titles.filter(Boolean).join(', ');
        setTitle(slot.closest('.session-rail-fact'), (original) => (named
          ? `${original}\n${jt('chat.sessionRail.tasks.jobWaitingFor', 'Waiting for it: {titles}', { titles: named })}` : null));
        setTitle(slot.closest('.session-rail-job')?.querySelector('[data-rail-job-stop]'), () => (count
          ? jt('chat.backgroundJobs.stopTitleWaiting', 'Stop this background job. {count} waiting for it.', { count }) : null));
      }
    }

    function tick() {
      const now = Date.now();
      for (const meta of tray.querySelectorAll('[data-rail-started-at]')) {
        const text = model.formatElapsed(now - Number(meta.getAttribute('data-rail-started-at')));
        if (meta.textContent !== text) meta.textContent = text;
      }
      syncWaiters();
    }

    // This chat's browser page: read on a chat switch, then pushed. A bridge that is missing reads as no page.
    function applyBrowser(state) {
      const open = state?.open === true && String(state.url || '').trim() !== '';
      const next = open ? { open: true, url: String(state.url), title: String(state.title || '') } : null;
      const same = next ? browser?.url === next.url && browser?.title === next.title : !browser;
      browser = next;
      if (!same && typeof onBrowserChange === 'function') onBrowserChange(browser);
    }

    function syncBrowser() {
      const sessionId = getSessionId();
      const bridge = getBrowserUse();
      const before = browser;
      browser = null;
      browserSeq += 1;
      if (before && typeof onBrowserChange === 'function') onBrowserChange(browser);
      if (!sessionId || typeof bridge?.getState !== 'function') return;
      const seq = browserSeq;
      Promise.resolve().then(() => bridge.getState({ session_id: sessionId })).then((state) => {
        if (!disposed && seq === browserSeq && state?.ok === true) applyBrowser(state);
      }).catch(() => {});
    }

    // After every repaint: fill live elapsed times and tick only while a live job is in sight.
    function sync() {
      if (disposed) return;
      const live = trayShown() && Boolean(tray.querySelector('[data-rail-started-at], [data-rail-job-waiting]'));
      if (live) tick();
      if (live && !ticker) ticker = win.setInterval(tick, TICK_MS);
      else if (!live && ticker) { win.clearInterval(ticker); ticker = 0; }
    }

    function stop(button) {
      const jobId = button.getAttribute('data-rail-job-stop');
      const refused = () => {
        button.disabled = false;
        button.title = jt('chat.backgroundJobs.stopFailed', 'Could not stop the background job.');
      };
      button.disabled = true;
      Promise.resolve(api()?.kill?.(jobId)).then((result) => { if (!result || result.ok !== true) refused(); }).catch(refused);
    }

    // Servers rows: Stop on a serving job, Close on the browser page; either disables itself until the next paint.
    function stopServer(button) {
      const target = button.getAttribute('data-rail-server-stop') || '';
      const browserRow = target === 'browser';
      const refused = () => {
        button.disabled = false;
        button.title = browserRow ? jt('chat.sessionRail.servers.closeFailed', 'Could not close the browser.') : jt('chat.backgroundJobs.stopFailed', 'Could not stop the background job.');
      };
      button.disabled = true;
      const call = browserRow ? () => getBrowserUse()?.close?.({ session_id: getSessionId() }) : () => api()?.kill?.(target.replace(/^job:/, ''));
      Promise.resolve().then(call).then((result) => { if (!result || result.ok !== true) refused(); }).catch(refused);
    }

    // The rail's tray click listener asks first; true means the click was Stop (a row's click opens the panel).
    function handleClick(event) {
      const target = event?.target?.closest ? event.target : null;
      const control = target && target.closest('[data-rail-job-stop], [data-rail-server-stop]');
      if (!control || !tray.contains(control)) return false;
      event.preventDefault();
      if (control.hasAttribute('data-rail-server-stop')) stopServer(control);
      else stop(control);
      return true;
    }

    const observer = typeof win.MutationObserver === 'function' ? new win.MutationObserver(sync) : null;
    observer?.observe(tray, { childList: true, subtree: true });
    const browserBridge = getBrowserUse();
    if (typeof browserBridge?.onChanged === 'function') {
      // A push is newer than any getState still in flight for this chat, so it wins (the seq bump drops that reply).
      browserOff = browserBridge.onChanged((event) => { if (!disposed && event?.session_id === getSessionId()) { browserSeq += 1; applyBrowser(event); } });
    }
    sync(); // the rail calls syncBrowser when it shows: a tray nobody sees reads nothing

    function dispose() {
      disposed = true;
      observer?.disconnect();
      if (typeof browserOff === 'function') browserOff();
      if (ticker) win.clearInterval(ticker);
      ticker = 0;
    }

    return { handleClick, sync, getBrowser: () => browser, syncBrowser, dispose };
  }

  return { createRailJobs, showOutputPathMenu };
});
