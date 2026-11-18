/* renderer/chat/renderer-session-rail-jobs.js - background-job rows of the session rail (UMD).

   Owner pick 2026-11-01: run_command background jobs live in the rail's Background tasks section
   (the chip strip above the composer is gone). The rail controller paints the rows from the model;
   this helper owns what a row does once painted, for ONE rail tray:
     - a live job's elapsed time ticks once a second while any is on screen;
     - Stop (data-rail-job-stop) calls backgroundJobs.kill and disables itself until the next paint (a
       refused stop re-enables it and says so in its tooltip);
     - a job's row opens it in the Background tasks panel (row 138, routed by the rail's detail click); a
       finished row's right-click offers the shared path menu on its output.txt once a hover or focus has
       read where that file is (backgroundJobs.readOutput, once per job);
     - a live job other chats wait on (row 100 P2 work leases) reads "N waiting · " before its time, and
       its hover and Stop tooltip say so; getJobWaiters returns the waiting chats' titles ('' if untitled);
     - the Session toggle reads "N running" while this chat has live jobs and the tray is out of sight
       (hidden, or a closed sheet). It counts from the tracker's own push (backgroundJobs.onChanged), since
       a hidden rail skips its summary refetches. Row 176: "N up" follows it for what this chat serves (a job
       with a loopback server, the browser page while open): "1 running · 2 up", zero parts left out;
     - Servers rows (row 176): Stop (data-rail-server-stop="job:<id>") kills the job like a job Stop and
       "browser" closes the chat's browser page, each disabling itself until the next paint (a refusal
       re-enables it). The chat's browser state (browserUse.getState, then its onChanged pushes for this chat)
       is read here and handed to the rail through getBrowser; onBrowserChange asks it to repaint.
   Job text renders through textContent only, never markup. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./renderer-session-rail-model'));
    return;
  }
  root.rendererSessionRailJobs = factory(root.rendererSessionRailModel);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (model) {
  'use strict';

  const TICK_MS = 1000;
  const MAX_KNOWN_PATHS = 20;
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

  function createRailJobs({ tray, toggle = null, win, jt, getSessionId = () => '', trayShown = () => true, getBackgroundJobs, getJobWaiters = null, pathMenu: injectedPathMenu = null, getWorkspaceRoot = null, getBrowserUse = () => win?.jennyShell?.browserUse, onBrowserChange = null } = {}) {
    if (!tray || !win) return { handleClick: () => false, getBrowser: () => null, syncBrowser: () => {}, dispose: () => {} };
    const paths = new Map(); // job id -> its output file path ('' while the read runs), once read
    let ticker = 0;
    let disposed = false;
    let trackedJobs = [];
    let unsubscribe = null;
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

    function syncReadout() {
      const slot = toggle?.querySelector('[data-session-rail-jobs-readout]');
      if (!slot || disposed) return;
      const sessionId = getSessionId();
      const live = sessionId ? trackedJobs.filter((job) => job?.sessionId === sessionId
        && (job.state === 'running' || job.state === 'killing')) : [];
      const serving = live.filter((job) => job.serving);
      const running = live.length - serving.length;
      const up = serving.length + (browser ? 1 : 0);
      const shown = (running > 0 || up > 0) && !trayShown();
      // One running test job also shows how far it is (row 96).
      const only = running === 1 ? live.find((job) => !job.serving) : null;
      const percent = Number.isFinite(only?.progress?.percent) ? Math.floor(only.progress.percent) : null;
      const parts = [];
      if (running > 0) {
        parts.push(percent == null
          ? jt('chat.sessionRail.tasks.running', '{count} running', { count: running })
          : jt('chat.sessionRail.tasks.runningPercent', '{count} running · {percent}%', { count: running, percent }));
      }
      if (up > 0) parts.push(jt('chat.sessionRail.servers.up', '{count} up', { count: up }));
      const text = shown ? parts.join(' · ') : '';
      if (slot.hidden === shown) slot.hidden = !shown;
      const value = slot.querySelector('[data-session-rail-jobs-readout-value]');
      if (value && value.textContent !== text) value.textContent = text;
    }

    // This chat's browser page: read on a chat switch, then pushed. A bridge that is missing reads as no page.
    function applyBrowser(state) {
      const open = state?.open === true && String(state.url || '').trim() !== '';
      const next = open ? { open: true, url: String(state.url), title: String(state.title || '') } : null;
      const same = next ? browser?.url === next.url && browser?.title === next.title : !browser;
      browser = next;
      syncReadout();
      if (!same && typeof onBrowserChange === 'function') onBrowserChange(browser);
    }

    function syncBrowser() {
      const sessionId = getSessionId();
      const bridge = getBrowserUse();
      const before = browser;
      browser = null;
      browserSeq += 1;
      if (before && typeof onBrowserChange === 'function') onBrowserChange(browser);
      if (!sessionId || typeof bridge?.getState !== 'function') return syncReadout();
      const seq = browserSeq;
      Promise.resolve().then(() => bridge.getState({ session_id: sessionId })).then((state) => {
        if (!disposed && seq === browserSeq && state?.ok === true) applyBrowser(state);
      }).catch(() => {});
    }

    function applyJobs(snapshot) {
      trackedJobs = Array.isArray(snapshot?.jobs) ? snapshot.jobs : [];
      syncReadout();
    }

    // After every repaint: fill live elapsed times and tick only while a live job is in sight.
    function sync() {
      if (disposed) return;
      syncReadout();
      const live = trayShown() && Boolean(tray.querySelector('[data-rail-started-at], [data-rail-job-waiting]'));
      if (live) tick();
      if (live && !ticker) ticker = win.setInterval(tick, TICK_MS);
      else if (!live && ticker) { win.clearInterval(ticker); ticker = 0; }
    }

    // A hover or focus on a finished row reads where its output file is, once, so a right-click can offer the path
    // menu (a failed read is forgotten and asked again next time).
    async function learnPath(event) {
      const row = event?.target?.closest ? event.target.closest('[data-rail-job-path]') : null;
      const jobId = row && tray.contains(row) ? row.getAttribute('data-rail-job-path') : '';
      if (!jobId || paths.has(jobId)) return;
      paths.set(jobId, '');
      let result;
      try { result = await api()?.readOutput?.(jobId); } catch { result = null; }
      if (disposed) return;
      if (!result || result.ok !== true) { paths.delete(jobId); return; }
      paths.set(jobId, String(result.fullOutputPath || ''));
      while (paths.size > MAX_KNOWN_PATHS) paths.delete(paths.keys().next().value);
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

    // The workspace the chat path controller resolves against (published through the shared resolver).
    function currentRoot() {
      try { return String((getWorkspaceRoot || (() => win.jennyWorkspacePathResolve?.getWorkspaceRoot?.()))() || ''); } catch { return ''; }
    }
    // Right-click on a finished job's row: the shared path menu on its output file, once its path is known.
    function handleContextMenu(event) {
      const target = event?.target?.closest ? event.target : null;
      const control = target && target.closest('[data-rail-job-path]');
      if (!control || !tray.contains(control)) return;
      const jobId = control.getAttribute('data-rail-job-path') || '';
      showOutputPathMenu({ jobId, fullOutputPath: paths.get(jobId), event, control, rootEl: tray, win,
        pathMenu: injectedPathMenu || win.rendererIdePathMenu, workspaceRoot: currentRoot() });
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

    tray.addEventListener('contextmenu', handleContextMenu);
    tray.addEventListener('mouseover', learnPath);
    tray.addEventListener('focusin', learnPath);
    const observer = typeof win.MutationObserver === 'function' ? new win.MutationObserver(sync) : null;
    observer?.observe(tray, { childList: true, subtree: true });
    // The toggle's own attributes move with the rail's mode and the sheet (syncToggle writes them).
    const toggleObserver = toggle && typeof win.MutationObserver === 'function' ? new win.MutationObserver(sync) : null;
    toggleObserver?.observe(toggle, { attributes: true, attributeFilter: ['aria-pressed', 'aria-expanded', 'hidden'] });
    const bridge = api();
    if (typeof bridge?.onChanged === 'function') unsubscribe = bridge.onChanged(applyJobs);
    if (typeof bridge?.getState === 'function') Promise.resolve(bridge.getState()).then((snapshot) => { if (!trackedJobs.length) applyJobs(snapshot); }).catch(() => {});
    const browserBridge = getBrowserUse();
    if (typeof browserBridge?.onChanged === 'function') {
      // A push is newer than any getState still in flight for this chat, so it wins (the seq bump drops that reply).
      browserOff = browserBridge.onChanged((event) => { if (!disposed && event?.session_id === getSessionId()) { browserSeq += 1; applyBrowser(event); } });
    }
    syncBrowser();
    sync();

    function dispose() {
      disposed = true;
      tray.removeEventListener('contextmenu', handleContextMenu);
      tray.removeEventListener('mouseover', learnPath);
      tray.removeEventListener('focusin', learnPath);
      observer?.disconnect();
      toggleObserver?.disconnect();
      if (typeof unsubscribe === 'function') unsubscribe();
      if (typeof browserOff === 'function') browserOff();
      if (ticker) win.clearInterval(ticker);
      ticker = 0;
    }

    return { handleClick, sync, syncReadout, getBrowser: () => browser, syncBrowser, dispose };
  }

  return { createRailJobs, showOutputPathMenu };
});
