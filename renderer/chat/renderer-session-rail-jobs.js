/* renderer/chat/renderer-session-rail-jobs.js - background-job rows of the session rail (UMD).

   Owner pick 2026-11-01: run_command background jobs live in the rail's Background tasks section
   (the chip strip above the composer is gone). The rail controller paints the rows from the model;
   this helper owns what a row does once painted, for ONE rail tray:
     - a live job's elapsed time ticks once a second while any is on screen;
     - Stop (data-rail-job-stop) calls backgroundJobs.kill and disables itself until the next paint (a
       refused stop re-enables it and says so in its tooltip);
     - a finished job's row (data-rail-job-output) opens its output below itself, read once over
       backgroundJobs.readOutput and kept across repaints; "Open full output" opens the job's
       output.txt in the Workspace when the job wrote one;
     - a live job other chats wait on (row 100 P2 work leases) reads "N waiting · " before its time, and
       its hover and Stop tooltip say so; getJobWaiters returns the waiting chats' titles ('' if untitled);
     - the Session toggle reads "N running" while this chat has live jobs and the tray is out of sight
       (hidden, or a closed sheet). It counts from the tracker's own push (backgroundJobs.onChanged), since
       a hidden rail skips its summary refetches.
   Job text renders through textContent only, never markup. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./renderer-session-rail-model'), require('../inventory/action-button'));
    return;
  }
  root.rendererSessionRailJobs = factory(root.rendererSessionRailModel, null);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (model, injectedActionButton) {
  'use strict';

  const TICK_MS = 1000;
  const MAX_CACHED_OUTPUTS = 20;

  function createRailJobs({ tray, toggle = null, win, jt, getSessionId = () => '', trayShown = () => true, getBackgroundJobs, getJobWaiters = null, pathMenu: injectedPathMenu = null, getWorkspaceRoot = null } = {}) {
    if (!tray || !win) return { handleClick: () => false, dispose: () => {} };
    const doc = tray.ownerDocument;
    const actionButton = (options) => (injectedActionButton || win.inventoryActionButton)(options);
    const outputs = new Map(); // job id -> { text, fullOutputPath } once read
    const open = new Set(); // job ids whose output is showing
    let ticker = 0;
    let disposed = false;
    let trackedJobs = [];
    let unsubscribe = null;

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

    function outputNode(jobId, entry) {
      const block = doc.createElement('div');
      block.className = 'session-rail-job-output';
      block.setAttribute('data-rail-job-output-for', jobId);
      const pre = doc.createElement('pre');
      pre.textContent = entry.text || jt('chat.sessionRail.tasks.noOutput', 'No output.');
      block.appendChild(pre);
      if (entry.fullOutputPath) {
        block.insertAdjacentHTML('beforeend', actionButton({
          plain: true, className: 'session-rail-job-open', label: jt('chat.sessionRail.tasks.openFullOutput', 'Open full output'),
          dataset: { 'rail-job-open': jobId },
        }));
      }
      return block;
    }

    function syncReadout() {
      const slot = toggle?.querySelector('[data-session-rail-jobs-readout]');
      if (!slot || disposed) return;
      const sessionId = getSessionId();
      const live = sessionId ? trackedJobs.filter((job) => job?.sessionId === sessionId
        && (job.state === 'running' || job.state === 'killing')) : [];
      const running = live.length;
      const shown = running > 0 && !trayShown();
      // One running test job also shows how far it is (row 96).
      const percent = running === 1 && Number.isFinite(live[0].progress?.percent) ? Math.floor(live[0].progress.percent) : null;
      const text = !shown ? '' : percent == null
        ? jt('chat.sessionRail.tasks.running', '{count} running', { count: running })
        : jt('chat.sessionRail.tasks.runningPercent', '{count} running · {percent}%', { count: running, percent });
      if (slot.hidden === shown) slot.hidden = !shown;
      const value = slot.querySelector('[data-session-rail-jobs-readout-value]');
      if (value && value.textContent !== text) value.textContent = text;
    }

    function applyJobs(snapshot) {
      trackedJobs = Array.isArray(snapshot?.jobs) ? snapshot.jobs : [];
      syncReadout();
    }

    // After every repaint: re-attach open outputs, fill live elapsed times and tick only while a live job is in sight.
    function sync() {
      if (disposed) return;
      syncReadout();
      for (const jobId of open) {
        const row = tray.querySelector(`[data-rail-job-output="${jobId}"]`);
        if (!row) continue;
        if (row.getAttribute('aria-expanded') !== 'true') row.setAttribute('aria-expanded', 'true');
        const wrapper = row.parentElement;
        if (outputs.has(jobId) && wrapper && !wrapper.querySelector('[data-rail-job-output-for]')) wrapper.appendChild(outputNode(jobId, outputs.get(jobId)));
      }
      const live = trayShown() && Boolean(tray.querySelector('[data-rail-started-at], [data-rail-job-waiting]'));
      if (live) tick();
      if (live && !ticker) ticker = win.setInterval(tick, TICK_MS);
      else if (!live && ticker) { win.clearInterval(ticker); ticker = 0; }
    }

    async function toggleOutput(row) {
      const jobId = row.getAttribute('data-rail-job-output');
      if (open.has(jobId)) {
        open.delete(jobId);
        row.setAttribute('aria-expanded', 'false');
        row.parentElement?.querySelector('[data-rail-job-output-for]')?.remove();
        return;
      }
      open.add(jobId);
      if (!outputs.has(jobId)) {
        let result;
        try { result = await api()?.readOutput?.(jobId); } catch { result = null; }
        if (disposed || !open.has(jobId)) return;
        if (!result || result.ok !== true) {
          // Said in place of the output; not cached, so a later open asks again.
          row.parentElement?.appendChild(outputNode(jobId, { text: jt('chat.sessionRail.tasks.outputUnavailable', "That job's output isn't available any more.") }));
          return;
        }
        outputs.set(jobId, { text: String(result.text || ''), fullOutputPath: String(result.fullOutputPath || '') });
        while (outputs.size > MAX_CACHED_OUTPUTS) {
          const evicted = outputs.keys().next().value;
          outputs.delete(evicted);
          open.delete(evicted);
          tray.querySelector(`[data-rail-job-output-for="${evicted}"]`)?.remove();
          tray.querySelector(`[data-rail-job-output="${evicted}"]`)?.setAttribute('aria-expanded', 'false');
        }
      }
      sync();
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

    // The workspace the chat path controller resolves against (published through the shared resolver).
    function currentRoot() {
      try { return String((getWorkspaceRoot || (() => win.jennyWorkspacePathResolve?.getWorkspaceRoot?.()))() || ''); } catch { return ''; }
    }
    const trimRoot = (value) => String(value || '').replace(/\\/g, '/').replace(/\/+$/, '');
    const sameRoot = (a, b) => (/^[A-Za-z]:/.test(a) ? a.toLowerCase() === b.toLowerCase() : a === b);

    // Right-click on a finished job's row or its Open full output button: the shared path menu on the job's
    // output file. workspaceFs speaks workspace-relative paths, and the tracker derives fullOutputPath only as
    // <root>/.jenny/tool-results/<jobId>/output.txt, so the relative path is rebuilt from the job id once the
    // read says the file exists. Anything else (no read yet, a path of another shape, or a job captured under
    // another workspace root than the current one, whose relative path would open the wrong file) leaves the
    // browser default.
    function handleContextMenu(event) {
      const target = event?.target?.closest ? event.target : null;
      const control = target && target.closest('[data-rail-job-output], [data-rail-job-open]');
      if (!control || !tray.contains(control)) return;
      const jobId = control.getAttribute('data-rail-job-output') || control.getAttribute('data-rail-job-open') || '';
      const full = String(outputs.get(jobId)?.fullOutputPath || '').replace(/\\/g, '/');
      const relative = `.jenny/tool-results/${jobId}/output.txt`;
      const pathMenu = injectedPathMenu || win.rendererIdePathMenu;
      if (!/^[0-9a-f]{12}$/.test(jobId) || !full.endsWith(`/${relative}`) || typeof pathMenu?.showPathMenu !== 'function') return;
      const jobRoot = trimRoot(full.slice(0, -(relative.length + 1)));
      const root = trimRoot(currentRoot());
      if (!root || !jobRoot || !sameRoot(jobRoot, root)) return;
      const shown = pathMenu.showPathMenu({
        path: relative, kind: 'file', windowRef: win, anchorX: event.clientX, anchorY: event.clientY, anchorEl: control, restoreFocusTo: control, rootEl: tray,
      });
      if (shown) event.preventDefault();
    }

    function openFull(jobId) {
      const target = outputs.get(jobId)?.fullOutputPath;
      if (!target || typeof win.CustomEvent !== 'function') return;
      win.dispatchEvent(new win.CustomEvent('ide:open-file-at-line', {
        detail: { path: target, line: null, column: null, preferIde: true }, bubbles: true, cancelable: true,
      }));
    }

    // The rail's tray click listener asks first; true means the click was a job control.
    function handleClick(event) {
      const target = event?.target?.closest ? event.target : null;
      const control = target && target.closest('[data-rail-job-stop], [data-rail-job-output], [data-rail-job-open]');
      if (!control || !tray.contains(control)) return false;
      event.preventDefault();
      if (control.hasAttribute('data-rail-job-stop')) stop(control);
      else if (control.hasAttribute('data-rail-job-open')) openFull(control.getAttribute('data-rail-job-open'));
      else void toggleOutput(control);
      return true;
    }

    tray.addEventListener('contextmenu', handleContextMenu);
    const observer = typeof win.MutationObserver === 'function' ? new win.MutationObserver(sync) : null;
    observer?.observe(tray, { childList: true, subtree: true });
    // The toggle's own attributes move with the rail's mode and the sheet (syncToggle writes them).
    const toggleObserver = toggle && typeof win.MutationObserver === 'function' ? new win.MutationObserver(sync) : null;
    toggleObserver?.observe(toggle, { attributes: true, attributeFilter: ['aria-pressed', 'aria-expanded', 'hidden'] });
    const bridge = api();
    if (typeof bridge?.onChanged === 'function') unsubscribe = bridge.onChanged(applyJobs);
    if (typeof bridge?.getState === 'function') Promise.resolve(bridge.getState()).then((snapshot) => { if (!trackedJobs.length) applyJobs(snapshot); }).catch(() => {});
    sync();

    function dispose() {
      disposed = true;
      tray.removeEventListener('contextmenu', handleContextMenu);
      observer?.disconnect();
      toggleObserver?.disconnect();
      if (typeof unsubscribe === 'function') unsubscribe();
      if (ticker) win.clearInterval(ticker);
      ticker = 0;
    }

    return { handleClick, sync, syncReadout, dispose };
  }

  return { createRailJobs };
});
