/* renderer/chat/renderer-session-bar.js - the session bar's title and diff control (UMD).

   Row 115. The pane's utility cluster is the session bar (styles/chat-session-bar.css); this module owns
   two of its children: the chat's title at the bar's start and the diff control. Other controllers mount
   their buttons into the same cluster, and CSS `order` fixes the visual sequence, so the place among the
   children does not matter.

   mountSessionBar({ pane, cluster, getSessionId, getTitle, signal, windowRef, jt, chatTimeline, bridge, detail })
     getTitle(sessionId)  the session's title ('' when it has none; the bar then shows "New session").
     bridge  window.jennyShell.chatWorkspace by default (listChanges, onChanged).
     detail  the Changes opener, window.rendererChatWorkspaceDetail by default (open, close, getCurrent).
   The diff control (CSS order 10) is one button: branch glyph, branch name, then the uncommitted +N -M in
   this chat's folder; it opens Changes (a click while Changes shows closes it). It reads on mount, on a
   session change and on onChanged for this session (debounced, one request in flight with one queued
   rerun, an answer for a previous session dropped), pauses while the document or the chat view is hidden, and never polls.
   It stays hidden until its own session's first answer and for a chat without a folder or a Git repo. The
   Session rail need not be showing.
   Returns { sync, dispose }. sync() re-reads the title (written only on change) and the session. It
   re-syncs on the events the session rail uses: `jenny:focused-chat-changed` (window) and
   `transcript-view-rendered` (the pane's timeline). Neither fires for a rename alone, so the pane
   composition's header sync calls syncAll(). A pane hosted in the IDE dock gets no bar and reads nothing.
   dispose() removes the nodes and every listener, and runs when the AbortSignal aborts. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererSessionBar = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const TITLE_SELECTOR = '[data-session-bar-title]';
  const DIFF_SELECTOR = '[data-session-bar-diff]';
  const SCHEMA_VERSION = 1;
  const REFETCH_DELAY_MS = 120;
  // An unavailable answer with one of these reasons (or state not_applicable) means "no folder / no repo".
  const NO_REPO_REASONS = new Set(['no_workspace', 'not_applicable', 'not_a_git_repository']);
  const BRANCH_GLYPH = '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="5" cy="3.75" r="1.5"/><circle cx="5" cy="12.25" r="1.5"/><circle cx="11" cy="6" r="1.5"/><path d="M5 5.25v5.5M11 7.5c0 2.5-6 1.5-6 3.5"/></svg>';
  const mounted = new Set(); // every live bar's sync, for a rename (syncAll)
  const mountedByCluster = new WeakMap(); // cluster -> dispose of its live bar; a remount retires it

  function hostedElsewhere(pane) {
    return pane.classList.contains('ide-chat-dock-body') || pane.hasAttribute('data-pane-hosted');
  }

  const fill = (template, params) => String(template).replace(/\{(\w+)\}/g, (match, name) => (params && params[name] !== undefined ? String(params[name]) : match));
  const count = (value) => (Number.isSafeInteger(value) && value >= 0 ? value : null);
  const text = (value) => (typeof value === 'string' ? value.trim() : '');

  // listChanges `data` -> what the control shows, or null when there is nothing to name.
  function readDiff(data) {
    if (!data || typeof data !== 'object') return null;
    const name = text(data.branch) || text(data.ref);
    if (!name) return null;
    const additions = count(data.additions);
    const deletions = count(data.deletions);
    const both = additions !== null && deletions !== null;
    return { name, files: count(data.file_count), additions: both ? additions : null, deletions: both ? deletions : null };
  }

  function mountSessionBar(options) {
    const o = options || {};
    const pane = o.pane;
    const cluster = o.cluster;
    if (!pane || !cluster || typeof o.getSessionId !== 'function' || typeof o.getTitle !== 'function') return null;
    if (o.signal && o.signal.aborted) return null;
    const doc = cluster.ownerDocument;
    const win = o.windowRef || (doc && doc.defaultView);
    if (!doc || !win || hostedElsewhere(pane)) return null;
    const jt = typeof o.jt === 'function' ? o.jt : (key, fallback, params) => fill(fallback, params);
    const i18n = win.jennyI18n;
    const jtn = (key, n, params, one, other) => (i18n && typeof i18n.tn === 'function'
      ? i18n.tn(key, n, params, one, other)
      : fill(n === 1 ? one : other, { count: n, ...params }));
    const bridge = o.bridge || (win.jennyShell && win.jennyShell.chatWorkspace) || null;
    const bridgeOk = Boolean(bridge && typeof bridge.listChanges === 'function');
    const escapeHtml = (win.stringUtils && win.stringUtils.escapeHtml) || (win.inventoryActionButton && win.inventoryActionButton.escapeHtml);
    const chatView = pane.closest ? pane.closest('.chat-view') : null;

    mountedByCluster.get(cluster)?.(); // retire the previous bar on this cluster (listeners, timer, nodes)
    cluster.querySelectorAll(`${TITLE_SELECTOR}, ${DIFF_SELECTOR}`).forEach((node) => node.remove());
    const node = doc.createElement('div');
    node.className = 'session-bar-title';
    node.setAttribute('data-session-bar-title', 'true');
    node.setAttribute('dir', 'auto'); // an English title keeps LTR inside RTL chrome
    cluster.insertBefore(node, cluster.firstChild);

    let disposed = false;
    let shown = null;
    const disposers = [];

    // ── Diff control ─────────────────────────────────────────────────────
    let button = null;
    if (bridgeOk && typeof win.inventoryActionButton === 'function' && escapeHtml) {
      cluster.insertAdjacentHTML('beforeend', win.inventoryActionButton({
        plain: true, className: 'chat-timeline-utility-button session-bar-diff', ariaPressed: false,
        dataset: { 'session-bar-diff': 'true' }, trustedHtml: '',
      }));
      button = cluster.querySelector(DIFF_SELECTOR);
      if (button) button.hidden = true;
    }
    let diffSession = null; // the session the control belongs to (null before the first sync)
    let diff = null;
    let paintedKey = '';
    let generation = 0;
    let fetching = false;
    let rerun = false;
    let owed = false; // a read was skipped while the document was hidden
    let timer = 0;
    // The document in the background, or another app view (Workspace, Home) showing instead of this chat.
    const viewHidden = () => doc.hidden || Boolean(chatView && chatView.classList.contains('hidden'));

    function tooltip() {
      const branch = diff.name;
      if (diff.files === 0) return jt('chat.sessionBar.diff.tipClean', 'Nothing uncommitted on {branch}', { branch });
      if (diff.files !== null && diff.additions !== null) {
        return jtn('chat.sessionBar.diff.tip', diff.files, { branch, additions: diff.additions, deletions: diff.deletions },
          'Uncommitted on {branch}: {count} file, +{additions} −{deletions}', 'Uncommitted on {branch}: {count} files, +{additions} −{deletions}');
      }
      if (diff.files !== null) {
        return jtn('chat.sessionBar.diff.tipFiles', diff.files, { branch }, 'Uncommitted on {branch}: {count} file', 'Uncommitted on {branch}: {count} files');
      }
      return jt('chat.sessionBar.diff.tipUnknown', 'On {branch}', { branch });
    }

    function contentHtml() {
      let numbers = '';
      if (diff.files !== 0 && diff.additions !== null) {
        numbers = `<span class="session-bar-diff-counts"><span class="session-rail-count--add">+${diff.additions}</span><span class="session-rail-count--del">−${diff.deletions}</span></span>`;
      } else if (diff.files) {
        numbers = `<span class="session-bar-diff-counts">${escapeHtml(jtn('chat.sessionBar.diff.files', diff.files, {}, '{count} file', '{count} files'))}</span>`;
      }
      return `${BRANCH_GLYPH}<span class="chat-timeline-utility-text session-bar-diff-text"><span class="session-bar-diff-branch" dir="auto">${escapeHtml(diff.name)}</span>${numbers}</span>`;
    }

    function paintDiff() {
      if (!button) return;
      if (!diff) {
        paintedKey = '';
        button.hidden = true;
        button.textContent = '';
        button.removeAttribute('title');
        button.removeAttribute('aria-label');
        return;
      }
      const tip = tooltip();
      const key = `${diff.name}\n${diff.files}\n${diff.additions}\n${diff.deletions}\n${tip}`;
      if (key !== paintedKey) {
        paintedKey = key;
        button.innerHTML = contentHtml();
        button.setAttribute('title', tip);
        button.setAttribute('aria-label', tip);
      }
      button.hidden = false;
    }

    // The Changes page is showing for this chat: the chat view is in code-review mode and the opener
    // (the owner API) says Changes belongs to this session.
    function changesShowing() {
      if (!diffSession || !chatView || !chatView.classList.contains('code-review-open')) return false;
      const detail = o.detail || win.rendererChatWorkspaceDetail;
      const current = detail && typeof detail.getCurrent === 'function' ? detail.getCurrent() : null;
      return Boolean(current) && current.surface === 'changes' && current.ownerSessionId === diffSession;
    }

    function syncPressed(forced) {
      if (!button) return;
      button.setAttribute('aria-pressed', (typeof forced === 'boolean' ? forced : changesShowing()) ? 'true' : 'false');
    }

    function applyAnswer(response) {
      if (!response || response.ok !== true) return; // a transient failure keeps the last good data
      if (response.state === 'available' || response.state === 'stale') {
        if (!response.data || typeof response.data !== 'object') return;
        diff = readDiff(response.data); // nothing to name (no branch, no commit): no control
      } else if (response.state === 'not_applicable' || (response.state === 'unavailable' && NO_REPO_REASONS.has(response.reason))) {
        diff = null;
      } else {
        return; // checking, or unavailable for a passing reason
      }
      paintDiff();
    }

    async function readChanges() {
      if (disposed || !button || !diffSession) return;
      if (viewHidden()) { owed = true; return; }
      if (fetching) { rerun = true; return; }
      fetching = true;
      const sid = diffSession;
      const requested = generation;
      const response = await Promise.resolve()
        .then(() => bridge.listChanges({ schema_version: SCHEMA_VERSION, session_id: sid }))
        .catch(() => null);
      fetching = false;
      if (disposed) return;
      if (requested === generation && sid === diffSession) applyAnswer(response);
      if (rerun) {
        rerun = false;
        void readChanges();
      }
    }

    function scheduleRead() {
      if (disposed || !button) return;
      if (timer) win.clearTimeout(timer);
      timer = win.setTimeout(() => {
        timer = 0;
        void readChanges();
      }, REFETCH_DELAY_MS);
    }

    // A different session clears the control first; it paints nothing until its own answer lands.
    function syncDiffSession(sessionId) {
      if (!button || sessionId === diffSession) return;
      diffSession = sessionId;
      generation += 1;
      diff = null;
      owed = false;
      rerun = false;
      if (timer) { win.clearTimeout(timer); timer = 0; }
      paintDiff();
      syncPressed();
      void readChanges();
    }

    function onVisibility() {
      if (disposed || viewHidden() || !owed) return;
      owed = false;
      void readChanges();
    }

    if (button) {
      button.addEventListener('click', () => {
        const detail = o.detail || win.rendererChatWorkspaceDetail;
        if (!detail || !diffSession) return;
        if (changesShowing()) {
          if (typeof detail.close !== 'function') return;
          detail.close();
          syncPressed(false); // the click's own frame; the observer confirms
          if (button.isConnected) button.focus();
        } else if (typeof detail.open === 'function'
          && detail.open({ surface: 'changes', ownerSessionId: diffSession, opener: button }) === true) {
          syncPressed(true);
        }
      });
      if (typeof win.MutationObserver === 'function' && chatView) {
        const observer = new win.MutationObserver(() => { syncPressed(); onVisibility(); });
        observer.observe(chatView, { attributes: true, attributeFilter: ['class'] });
        disposers.push(() => observer.disconnect());
      }
      doc.addEventListener('visibilitychange', onVisibility);
      disposers.push(() => doc.removeEventListener('visibilitychange', onVisibility));
      if (typeof bridge.onChanged === 'function') {
        const unsubscribe = bridge.onChanged((event) => {
          if (disposed || !event || typeof event !== 'object' || event.session_id !== diffSession) return;
          scheduleRead();
        });
        if (typeof unsubscribe === 'function') disposers.push(unsubscribe);
      }
    }

    // ── Title and session ────────────────────────────────────────────────
    function sync() {
      if (disposed) return;
      const sessionId = String(o.getSessionId() || '').trim();
      syncDiffSession(sessionId);
      const title = (sessionId && String(o.getTitle(sessionId) || '').trim()) || jt('chat.empty.newSession', 'New session');
      if (title === shown) return;
      shown = title;
      node.textContent = title;
      node.setAttribute('title', title);
    }

    function listen(target, type, handler) {
      if (!target || typeof target.addEventListener !== 'function') return;
      target.addEventListener(type, handler);
      disposers.push(() => target.removeEventListener(type, handler));
    }
    listen(win, 'jenny:focused-chat-changed', sync);
    listen(o.chatTimeline, 'transcript-view-rendered', sync);

    function dispose() {
      if (disposed) return;
      disposed = true;
      mounted.delete(sync);
      if (mountedByCluster.get(cluster) === dispose) mountedByCluster.delete(cluster);
      if (timer) win.clearTimeout(timer);
      timer = 0;
      while (disposers.length) {
        const release = disposers.pop();
        try { release(); } catch (_error) { /* best-effort teardown, as the rail does */ }
      }
      node.remove();
      if (button) button.remove();
    }
    if (o.signal && typeof o.signal.addEventListener === 'function') {
      o.signal.addEventListener('abort', dispose, { once: true });
      disposers.push(() => o.signal.removeEventListener('abort', dispose));
    }

    mountedByCluster.set(cluster, dispose);
    mounted.add(sync);
    sync();
    return { sync, dispose };
  }

  // A chat's title changed (the pane composition's header sync): every bar re-reads its own.
  function syncAll() {
    mounted.forEach((sync) => sync());
  }

  return { mountSessionBar, syncAll };
});
