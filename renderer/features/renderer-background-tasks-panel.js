/* renderer/features/renderer-background-tasks-panel.js - the Background tasks panel (row 138, UMD).

   The `background_tasks` mode of the chat's right-hand panel: this chat's background commands
   (window.jennyShell.backgroundJobs) and linked chats (the chat workspace summary), a list with a filter and a
   finished fold, and a task opened in the panel with its live output. Loaded lazily on first open; the shell
   (renderer-shell-artifact-rails.js) builds one controller, lets renderSplitDetail PULL its markup through
   renderRailContent and publishes window.rendererBackgroundTasksPanel. Markup lives in -render.js.
   Output is read every 1500 ms while the open command runs and the panel and document are visible, one read at a
   time, once more when it settles. A push re-renders the list (focus and scroll kept); on the detail page only the
   status line and the foot are swapped, never the output. Nothing is persisted; dispose() releases everything. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./renderer-background-tasks-panel-render'), require('../chat/renderer-session-rail-jobs'));
    return;
  }
  root.rendererBackgroundTasksPanelOwner = factory(root.rendererBackgroundTasksPanelRender, root.rendererSessionRailJobs);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (renderModule, railJobsModule) {
  'use strict';
  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  const MODE = 'background_tasks';
  const POLL_MS = 1500;
  const TICK_MS = 1000;
  const SUMMARY_DELAY_MS = 120;
  const COPIED_MS = 1600;
  const FOCUS_KEYS = ['data-bgt-open', 'data-bgt-stop', 'data-bgt-fold', 'data-bgt-clear', 'data-bgt-back', 'data-bgt-copy-command',
    'data-bgt-copy-output', 'data-bgt-open-address', 'data-bgt-copy-address', 'data-bgt-open-full', 'data-bgt-open-chat', 'data-bgt-jump', 'data-value'];
  function noop() {}

  /* Stops a linked chat's turn: the renderer's own Stop first, else the turn the main process knows. Truthy when stopped. */
  function createStopSession({ stopSessionStream, getChat } = {}) {
    return async function stopSession(sessionId) {
      const id = String(sessionId || '').trim();
      if (!id) return false;
      try { if (typeof stopSessionStream === 'function' && await stopSessionStream(id)) return true; } catch (_error) { /* try the turn below */ }
      try {
        const chat = typeof getChat === 'function' ? getChat() : null;
        const turn = await chat?.getActiveTurnState?.(id);
        const streamId = String(turn?.stream_id || '').trim();
        if (!streamId || typeof chat.cancelStream !== 'function') return false;
        const result = await chat.cancelStream(streamId);
        return !(result === false || (result && typeof result === 'object' && result.ok === false));
      } catch (_error) { return false; }
    };
  }

  function createBackgroundTasksPanel(deps) {
    const d = deps || {};
    const state = d.state;
    if (!state || typeof state !== 'object') throw new Error('renderer-background-tasks-panel: state dep is required');
    const rr = renderModule || globalThis.rendererBackgroundTasksPanelRender;
    const railJobs = railJobsModule || globalThis.rendererSessionRailJobs || {};
    const win = d.windowRef || globalThis.window || globalThis;
    const doc = win.document;
    const panelEl = d.dom?.artifactReviewPanel || null;
    const fn = (value, fallback = noop) => (typeof value === 'function' ? value : fallback);
    const [openArtifactRail, renderArtifactReviewPanel, closePanel, claimOwner, openSession, appendClientLog] = [d.openArtifactRail,
      d.renderArtifactReviewPanel, d.toggleArtifactReview, d.claimOwner, d.openSession, d.appendClientLog].map((value) => fn(value));
    const stopSession = fn(d.stopSession, async () => false);
    const getPanelSessionId = fn(d.getPanelSessionId, () => state.currentSessionId);
    const setT = fn(d.setTimeoutImpl, (cb, ms) => win.setTimeout(cb, ms));
    const clearT = fn(d.clearTimeoutImpl, (id) => win.clearTimeout(id));
    const setI = fn(d.setIntervalImpl, (cb, ms) => win.setInterval(cb, ms));
    const clearI = fn(d.clearIntervalImpl, (id) => win.clearInterval(id));
    const now = fn(d.now, () => Date.now());
    const jobsApi = () => win.jennyShell?.backgroundJobs || null;
    const workspaceApi = () => win.jennyShell?.chatWorkspace || null;

    let disposed = false, bound = false;
    let sessionId = null; // the session last painted; null until the first paint
    let page = 'list', openTaskId = '', returnTaskId = ''; // returnTaskId: the row Back gives focus to
    let filter = 'all', foldOpen = true, jobs = [], chatItems = [];
    let out = null; // the open command's output: { jobId, text, truncated, fullOutputPath, failed, loaded }
    let following = true, wasLive = false, opener = null, lastListHtml = '', hostRef = null;
    let pollTimer = null, reading = false, rereadAfter = false, ticker = 0, summaryTimer = null, fetching = null, copiedTimer = null, copiedReset = noop;
    const unsubscribers = [];

    const sid = () => String(getPanelSessionId() || '').trim();
    const rootEl = () => panelEl?.querySelector?.('.background-tasks-panel') || null;
    const tasks = () => rr.buildTasks({ jobs, items: chatItems, sessionId: sessionId || sid() });
    const currentTask = () => (openTaskId ? tasks().find((task) => task.id === openTaskId) || null : null);
    const docHidden = () => doc?.visibilityState === 'hidden';
    const logWarn = (event, error) => appendClientLog('WARN', event, { message: String(error?.message || error || '').slice(0, 200) });

    function isOpen() {
      const prefs = state.ui?.artifactReview || {};
      return !disposed && prefs.mode === MODE && prefs.enabled === true && prefs.collapsed !== true && !panelEl?.classList?.contains('hidden');
    }

    // ── Data ──
    function applyJobs(snapshot) { if (!disposed) { jobs = Array.isArray(snapshot?.jobs) ? snapshot.jobs : []; refresh(); } }

    async function loadJobs() {
      try { const snapshot = await jobsApi()?.getState?.(); if (snapshot && !disposed) jobs = Array.isArray(snapshot.jobs) ? snapshot.jobs : []; } catch (error) { logWarn('background_tasks.jobs_read_failed', error); }
    }

    // The linked chats come from the chat workspace summary the session rail reads; one request at a time.
    function fetchSummary() {
      if (fetching) return fetching;
      const target = sid();
      const api = workspaceApi();
      if (!target || typeof api?.getSummary !== 'function') return Promise.resolve();
      fetching = Promise.resolve().then(() => api.getSummary({ schema_version: 1, session_id: target })).catch(() => null).then((response) => {
        fetching = null;
        if (!disposed && target !== sid()) return void fetchSummary(); // the chat changed meanwhile: ask for the new one
        if (disposed || response?.ok !== true || response.summary?.session_id !== target) return;
        const items = response.summary.background_tasks?.data?.items;
        chatItems = Array.isArray(items) ? items : [];
        refresh();
      });
      return fetching;
    }

    function scheduleSummary(event) {
      if (disposed || event?.session_id !== sid() || !isOpen() || summaryTimer) return;
      summaryTimer = setT(() => { summaryTimer = null; void fetchSummary(); }, SUMMARY_DELAY_MS);
    }

    // ── Painting ──
    function prepareSurface(surface) {
      if (!surface) return null;
      surface.detailPanel?.classList?.remove('hidden');
      for (const hidden of [surface.detailEmpty, surface.metaPane, surface.saveButton, surface.revertButton, surface.revealButton,
        surface.openExternalButton, surface.deleteButton, surface.editorShell, surface.dirtyBadge]) hidden?.classList?.add('hidden');
      for (const field of [surface.detailKicker, surface.detailTitle, surface.detailPath, surface.detailStatus, surface.detailNote]) if (field) field.textContent = '';
      if (surface.detailMeta) surface.detailMeta.innerHTML = '';
      if (surface.provenanceTimeline) surface.provenanceTimeline.innerHTML = '';
      const host = surface.previewContent || surface;
      host?.classList?.remove?.('hidden');
      return host;
    }

    // The focused control, as an attribute and value a repaint can find again.
    function focusKey(scope) {
      const active = doc?.activeElement;
      if (!active || !scope?.contains?.(active)) return null;
      const attr = FOCUS_KEYS.find((name) => active.hasAttribute?.(name));
      return attr ? [attr, active.getAttribute(attr)] : null;
    }
    function restoreFocus(scope, key) {
      if (!key || scope?.contains?.(doc?.activeElement)) return;
      const target = Array.from(scope.querySelectorAll(`[${key[0]}]`)).find((node) => node.getAttribute(key[0]) === key[1]);
      target?.focus?.();
    }

    // Replaces one part of the open task (the status line, the foot) only when its markup changed.
    const painted = new WeakMap(); // a part -> the markup it was painted from
    function swap(selector, html) {
      const scope = rootEl();
      const node = scope?.querySelector(selector);
      if (!node || painted.get(node) === html) return;
      const key = focusKey(node);
      node.outerHTML = html;
      const next = scope.querySelector(selector);
      if (next) painted.set(next, html);
      restoreFocus(scope, key);
    }
    const swapFoot = (task) => swap('[data-bgt-foot]', rr.footHtml(task, out, following));

    function paintList(host) {
      const list = rootEl()?.querySelector('.background-tasks-list');
      const html = `<div class="background-tasks-panel" data-bgt-page="list">${rr.listHtml({
        tasks: tasks(), filter, foldOpen, clearable: typeof jobsApi()?.clearFinished === 'function' })}</div>`;
      if (html === lastListHtml && rootEl()?.dataset.bgtPage === 'list') return;
      const key = focusKey(host);
      const scrollTop = list?.scrollTop || 0;
      host.innerHTML = html;
      lastListHtml = html;
      const next = rootEl()?.querySelector('.background-tasks-list');
      if (next && scrollTop) next.scrollTop = scrollTop;
      restoreFocus(host, key);
    }

    function paintDetail(host, task) {
      const existing = rootEl()?.querySelector('[data-bgt-detail]');
      if (existing && existing.getAttribute('data-bgt-detail') === task.id) return patchDetail(task);
      host.innerHTML = `<div class="background-tasks-panel" data-bgt-page="detail">${rr.detailHtml(task, out, following)}</div>`;
      lastListHtml = '';
      painted.set(host.querySelector('[data-bgt-status]'), rr.statusLineHtml(task));
      painted.set(host.querySelector('[data-bgt-facts]'), rr.factsHtml(task));
      painted.set(host.querySelector('[data-bgt-foot]'), rr.footHtml(task, out, following));
    }

    function patchDetail(task) {
      const detail = rootEl()?.querySelector('[data-bgt-detail]');
      if (!detail) return;
      swap('[data-bgt-status]', rr.statusLineHtml(task));
      swap('[data-bgt-facts]', rr.factsHtml(task));
      swapFoot(task);
      if (wasLive && !task.live) {
        const words = detail.querySelector('[data-bgt-status] > span:not(.background-tasks-actions)')?.textContent || '';
        const region = detail.querySelector('[data-bgt-announce]');
        if (region) region.textContent = words; // said once: running to finished
      }
    }

    function patchOutput() {
      const task = currentTask();
      const detail = rootEl()?.querySelector('[data-bgt-detail]');
      if (!task || task.kind !== 'command' || !detail) return;
      const pre = detail.querySelector('[data-bgt-output]');
      const text = rr.outputText(task, out);
      if (pre && pre.textContent !== text) {
        pre.textContent = text;
        if (following) pre.scrollTop = pre.scrollHeight;
      }
      const note = detail.querySelector('[data-bgt-truncated]');
      if (note && note.hidden === (out?.truncated === true)) note.hidden = out?.truncated !== true;
      swapFoot(task);
    }

    function paint() {
      const host = rootEl()?.parentElement || hostRef;
      if (disposed || !host) return;
      const task = page === 'detail' ? currentTask() : null;
      if (page === 'detail' && !task) leaveDetail(); // cleared or evicted: back to the list
      if (task) paintDetail(host, task); else paintList(host);
      if (task) wasLive = task.live;
      syncTicker();
    }

    // Session switch: the panel stays open on the newly focused chat's list, filter back on All.
    function syncSession() {
      const next = sid();
      if (next === sessionId) return;
      const first = sessionId === null;
      sessionId = next;
      chatItems = [];
      filter = 'all';
      if (!first) leaveDetail();
      lastListHtml = '';
      void fetchSummary();
    }

    function renderRailContent(surface) {
      const host = prepareSurface(surface);
      if (!host || disposed) return false;
      hostRef = host;
      syncSession();
      paint();
      syncPolling();
      return true;
    }

    function refresh() {
      if (disposed || !isOpen() || !rootEl()) return;
      const task = page === 'detail' ? currentTask() : null;
      if (page === 'detail' && !task) { leaveDetail(); renderArtifactReviewPanel(); return; } // the title leaves the task too
      const settled = task && wasLive && !task.live;
      paint();
      if (settled) readNow(); // the final tail
      syncPolling();
    }

    // ── Clocks ──
    function tick() {
      const at = now();
      for (const node of rootEl()?.querySelectorAll('[data-bgt-started-at]') || []) {
        const text = rr.formatClock(at - Number(node.getAttribute('data-bgt-started-at')));
        if (node.textContent !== text) node.textContent = text;
      }
    }
    function syncTicker() {
      const needed = isOpen() && Boolean(rootEl()?.querySelector('[data-bgt-started-at]'));
      if (needed) tick();
      if (needed && !ticker) ticker = setI(() => (isOpen() ? tick() : syncTicker()), TICK_MS);
      else if (!needed && ticker) { clearI(ticker); ticker = 0; }
    }

    // ── Live output ──
    function wantsPoll() {
      const task = page === 'detail' ? currentTask() : null;
      return Boolean(task && task.kind === 'command' && task.live && isOpen() && !docHidden());
    }
    function stopPolling() { if (pollTimer) clearT(pollTimer); pollTimer = null; }
    function syncPolling() {
      if (!wantsPoll()) return stopPolling();
      if (!pollTimer && !reading) pollTimer = setT(() => { pollTimer = null; if (wantsPoll()) readNow(); }, POLL_MS);
    }

    async function readNow() {
      const task = currentTask();
      if (disposed || !task || task.kind !== 'command') return;
      if (reading) { rereadAfter = true; return; }
      reading = true;
      let result;
      try { result = await jobsApi()?.readOutput?.(task.jobId); } catch (_error) { result = null; }
      reading = false;
      if (disposed) return;
      if (openTaskId !== task.id || page !== 'detail') { // a stale answer: the task open now still needs its own read
        rereadAfter = false;
        if (page === 'detail') readNow();
        return;
      }
      // A live read that found no usable file (stale) or a failed read never blanks a tail already on screen.
      if (result?.ok === true) {
        if (!(result.stale === true && out?.text)) out = { jobId: task.jobId, text: String(result.text || ''), truncated: result.truncated === true, fullOutputPath: String(result.fullOutputPath || ''), failed: false, loaded: true };
      } else if (!out?.text) out = { ...(out || {}), jobId: task.jobId, failed: true, loaded: true };
      patchOutput();
      if (rereadAfter) { rereadAfter = false; readNow(); return; }
      syncPolling();
    }

    // ── Pages ──
    function leaveDetail() {
      stopPolling();
      if (page === 'detail') returnTaskId = openTaskId;
      [page, openTaskId, out, rereadAfter] = ['list', '', null, false];
    }

    function openTask(taskId) {
      const task = tasks().find((entry) => entry.id === taskId);
      if (!task) return false;
      [page, openTaskId, returnTaskId, out, following, wasLive] = ['detail', task.id, task.id, null, true, task.live];
      renderArtifactReviewPanel();
      panelEl?.querySelector?.('[data-bgt-back]')?.focus?.();
      if (task.kind === 'command') readNow();
      return true;
    }

    function back() {
      const target = openTaskId || returnTaskId;
      leaveDetail();
      renderArtifactReviewPanel();
      const row = Array.from(panelEl?.querySelectorAll?.('[data-bgt-open]') || []).find((node) => node.getAttribute('data-bgt-open') === target);
      (row || panelEl?.querySelector?.('.background-tasks-toolbar [aria-checked="true"]'))?.focus?.();
    }

    async function open(options) {
      if (disposed) return false;
      const o = options || {};
      const owner = String(o.sessionId || '').trim();
      if (owner) claimOwner(owner);
      opener = o.opener && typeof o.opener.focus === 'function' ? o.opener : opener;
      syncSession();
      await Promise.all([loadJobs(), fetchSummary()]);
      if (disposed) return false;
      leaveDetail();
      openArtifactRail(MODE);
      renderArtifactReviewPanel();
      const taskId = String(o.taskId || '').trim();
      if (taskId) openTask(taskId); // an unknown id stays on the list
      return isOpen();
    }

    function close() {
      if (!isOpen()) return false;
      leaveDetail();
      closePanel();
      syncTicker();
      if (opener?.isConnected && typeof opener.focus === 'function') opener.focus();
      return true;
    }

    // ── Actions ──
    function stop(button) {
      const id = button.getAttribute('data-bgt-stop') || '';
      const task = tasks().find((entry) => entry.id === id);
      if (!task) return;
      const refused = () => {
        if (!button.isConnected) return;
        button.disabled = false;
        button.title = task.kind === 'chat' ? jt('backgroundTasks.stopChatFailed', 'Could not stop this chat.') : jt('chat.backgroundJobs.stopFailed', 'Could not stop the background job.');
      };
      button.disabled = true;
      const pending = task.kind === 'chat' ? Promise.resolve(stopSession(task.sessionId)).then((ok) => Boolean(ok))
        : Promise.resolve(jobsApi()?.kill?.(task.jobId)).then((result) => result?.ok === true);
      pending.then((ok) => { if (!ok) refused(); }, refused);
    }

    async function clearFinished() {
      const api = jobsApi();
      if (typeof api?.clearFinished !== 'function') return;
      try { await api.clearFinished(sessionId); } catch (error) { logWarn('background_tasks.clear_failed', error); }
      await loadJobs();
      if (disposed) return;
      paint();
      (panelEl?.querySelector?.('[data-bgt-open]') || panelEl?.querySelector?.('.background-tasks-toolbar [aria-checked="true"]'))?.focus?.();
    }

    function copy(button, text) {
      const clipboard = win.jennyShell?.clipboard;
      const region = rootEl()?.querySelector('[data-bgt-announce]');
      const say = (words) => { if (region?.isConnected) region.textContent = words; };
      if (!text || typeof clipboard?.writeText !== 'function') return;
      Promise.resolve().then(() => clipboard.writeText(text)).then(() => {
        const copied = jt('backgroundTasks.copied', 'Copied');
        say(copied);
        if (copiedTimer) { clearT(copiedTimer); copiedReset(); } // the button flashed before gets its label back first
        const label = button.textContent;
        if (button.isConnected) button.textContent = copied;
        copiedReset = () => { copiedTimer = null; if (button.isConnected) button.textContent = label; };
        copiedTimer = setT(copiedReset, COPIED_MS);
      }, () => say(jt('backgroundTasks.copyFailed', 'Could not copy.')));
    }

    function openFull() {
      const target = out?.fullOutputPath;
      if (!target || typeof win.CustomEvent !== 'function') return;
      win.dispatchEvent(new win.CustomEvent('ide:open-file-at-line', { detail: { path: target, line: null, column: null, preferIde: true }, bubbles: true, cancelable: true }));
    }

    // Row 176: a serving job's address opens in the user's own browser (window.open, which the main window turns into
    // the OS default browser), and only a loopback http(s) address does.
    function openAddress() {
      const href = rr.loopbackUrl(currentTask()?.serving?.url);
      if (href && typeof win.open === 'function') win.open(href, '_blank', 'noopener,noreferrer');
    }

    function jumpToLatest() {
      const pre = rootEl()?.querySelector('[data-bgt-output]');
      following = true;
      if (pre) pre.scrollTop = pre.scrollHeight;
      if (currentTask()) swapFoot(currentTask());
      pre?.focus?.();
    }

    function setFilter(value) { filter = rr.FILTERS.includes(value) ? value : 'all'; paint(); }

    const inPanel = (event) => !disposed && state.ui?.artifactReview?.mode === MODE && Boolean(rootEl() || event.target?.closest?.('[data-bgt-back]'));

    function handleClick(event) {
      if (!inPanel(event)) return;
      const target = event.target;
      const hit = (selector) => target?.closest?.(selector);
      let node;
      if (hit('[data-bgt-back]')) return back();
      if ((node = hit('[data-action="bgt-filter"] [data-value]'))) return setFilter(node.getAttribute('data-value'));
      if (hit('[data-bgt-fold]')) { foldOpen = !foldOpen; return paint(); }
      if (hit('[data-bgt-clear]')) return void clearFinished();
      if ((node = hit('[data-bgt-stop]'))) return stop(node);
      if ((node = hit('[data-bgt-open]'))) return void openTask(node.getAttribute('data-bgt-open'));
      if ((node = hit('[data-bgt-copy-command]'))) return copy(node, currentTask()?.text || '');
      if ((node = hit('[data-bgt-copy-output]'))) return copy(node, out?.failed ? '' : out?.text || '');
      if (hit('[data-bgt-open-address]')) return openAddress();
      if ((node = hit('[data-bgt-copy-address]'))) return copy(node, currentTask()?.serving?.url || '');
      if (hit('[data-bgt-open-full]')) return openFull();
      if ((node = hit('[data-bgt-open-chat]'))) return void openSession(node.getAttribute('data-bgt-open-chat'));
      if (hit('[data-bgt-jump]')) return jumpToLatest();
    }

    function handleSegmentedChange(event) {
      if (inPanel(event) && event.detail?.id === 'bgt-filter') setFilter(event.detail.value);
    }

    // Capture phase: the panel's own Escape (close) listens on the same element.
    function handleKeydown(event) {
      if (event.key !== 'Escape' || event.isComposing || !inPanel(event) || page !== 'detail' || !rootEl()?.contains(event.target)) return;
      event.preventDefault();
      event.stopPropagation();
      back();
    }

    // Following the bottom stops once the reader scrolls up and resumes at the bottom.
    function handleScroll(event) {
      const pre = event.target;
      if (!pre?.matches?.('[data-bgt-output]') || !inPanel(event)) return;
      const atBottom = pre.scrollHeight - pre.scrollTop - pre.clientHeight <= 8;
      if (atBottom === following) return;
      following = atBottom;
      if (currentTask()) swapFoot(currentTask());
    }

    function handleContextMenu(event) {
      const control = inPanel(event) ? event.target?.closest?.('[data-bgt-open-full]') : null;
      if (!control || typeof railJobs.showOutputPathMenu !== 'function') return;
      let workspaceRoot = '';
      try { workspaceRoot = String(win.jennyWorkspacePathResolve?.getWorkspaceRoot?.() || ''); } catch (_error) { /* no root: browser default */ }
      railJobs.showOutputPathMenu({ jobId: control.getAttribute('data-bgt-open-full'), fullOutputPath: out?.fullOutputPath, event, control,
        rootEl: panelEl, win, pathMenu: d.pathMenu || win.rendererIdePathMenu, workspaceRoot });
    }

    function handleVisibility() { if (!disposed) syncPolling(); }

    const listeners = [['click', handleClick, false], ['inv-segmented-change', handleSegmentedChange, false], ['keydown', handleKeydown, true],
      ['scroll', handleScroll, true], ['contextmenu', handleContextMenu, false]];

    function bind() {
      if (bound || disposed) return;
      bound = true;
      for (const [type, listener, capture] of listeners) panelEl?.addEventListener?.(type, listener, capture);
      doc?.addEventListener?.('visibilitychange', handleVisibility);
      const jobsBridge = jobsApi();
      if (typeof jobsBridge?.onChanged === 'function') unsubscribers.push(jobsBridge.onChanged(applyJobs));
      const workspace = workspaceApi();
      if (typeof workspace?.onChanged === 'function') unsubscribers.push(workspace.onChanged(scheduleSummary));
      void loadJobs();
    }

    function dispose() {
      if (disposed) return;
      disposed = true;
      stopPolling();
      if (ticker) clearI(ticker);
      for (const timer of [summaryTimer, copiedTimer]) if (timer) clearT(timer);
      [ticker, summaryTimer, copiedTimer] = [0, null, null];
      if (bound) for (const [type, listener, capture] of listeners) panelEl?.removeEventListener?.(type, listener, capture);
      doc?.removeEventListener?.('visibilitychange', handleVisibility);
      while (unsubscribers.length) { const off = unsubscribers.pop(); try { if (typeof off === 'function') off(); } catch (_error) { /* best effort */ } }
    }

    const titleHtml = () => (page === 'detail' && currentTask() ? rr.titleHtml() : '');

    return { bind, dispose, open, close, isOpen, renderRailContent, titleHtml, refresh };
  }

  return { createBackgroundTasksPanel, createStopSession, MODE };
});
