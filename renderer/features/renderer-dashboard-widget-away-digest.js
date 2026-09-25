/* Home dashboard "While you were away" reader + widget (UMD). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('../shell/renderer-away-digest-model'), require('../shared/log-view-utils'));
    return;
  }
  // Both globals load AFTER this script in index.html; resolve them at first
  // use, never at load time (a lazily-resolved global must never be captured).
  root.rendererDashboardWidgetAwayDigest = factory(null, null);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (digestModelRef, logViewUtilsRef) {
  'use strict';

  function model() {
    if (!digestModelRef) digestModelRef = globalThis.rendererAwayDigestModel;
    return digestModelRef;
  }
  function logView() {
    if (!logViewUtilsRef) logViewUtilsRef = globalThis.logViewUtils;
    return logViewUtilsRef;
  }

  var jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  var jtn = (globalThis.jennyI18n && globalThis.jennyI18n.tn) || function (k, count, params, one, other) { return jt.call(null, k, count === 1 ? one : other, params); };
  var SEEN_STORAGE_KEY = 'jenny.ui.awayDigest.seenAt';
  var SESSION_SEEN_STORAGE_KEY = 'jenny.ui.awayDigest.seenBySession';
  var SNAPSHOT_LIMIT = 100;
  var USAGE_LIMIT = 200;
  var META_SEPARATOR = ' · ';
  var BODY_TEARDOWNS = new WeakMap();
  function localeTag() {
    return globalThis.jennyI18n && typeof globalThis.jennyI18n.tag === 'function' ? globalThis.jennyI18n.tag() : undefined;
  }

  function formatCount(value) {
    return Number(value || 0).toLocaleString(localeTag());
  }
  function relativeTime(value) {
    var utils = logView();
    return utils && typeof utils.formatRelativeTime === 'function'
      ? utils.formatRelativeTime(value) : String(value || '');
  }

  function isAfter(left, right) {
    var leftMs = Date.parse(left);
    var rightMs = Date.parse(right);
    if (Number.isNaN(leftMs) || Number.isNaN(rightMs)) return String(left) > String(right);
    return leftMs > rightMs;
  }
  function createAwayDigestReader(deps) {
    var options = deps && typeof deps === 'object' ? deps : {};
    var windowRef = options.windowRef || globalThis;
    var documentRef = options.documentRef || windowRef.document || null;
    var state = options.state && typeof options.state === 'object' ? options.state : {};
    var callbacks = options.callbacks && typeof options.callbacks === 'object' ? options.callbacks : {};
    var page = [], pageReadAt = ''; // pageReadAt: when `page` was requested; cursors written then or later cover runs it may not have seen
    var seenAt = null;
    var seenBySession = null;
    var limit = model().DEFAULT_ROW_LIMIT;
    var loading = false;
    var readFailed = false;
    var hasRead = false;
    var inFlight = null;
    var disposed = false;
    var lastPanelVisible = null;
    var lastChromeSession = '';
    var usagePromise = null;
    var workStreamPromises = new Map();
    var tokenValues = new Map();
    var tokenWarnings = new Set();
    var usageFailed = false;
    var listeners = [];
    var watchedAt = {}; // last instant each chat was on screen; committed as its cursor at read/switch/hide
    var published = null;

    function log(level, event, data) {
      if (typeof callbacks.appendClientLog === 'function') callbacks.appendClientLog(level, event, data);
    }
    /* Two guards, not one: resolving the store can throw behind a blocked
     * origin, and so can each access once it resolves. */
    function resolveStorage() {
      if (options.storage && typeof options.storage.getItem === 'function') return options.storage;
      try { return windowRef.localStorage || null; } catch (_error) { return null; }
    }

    function readStored(key) {
      var store = resolveStorage();
      if (!store) return '';
      try { return String(store.getItem(key) || ''); } catch (_error) { return ''; }
    }

    function writeStored(key, value) {
      var store = resolveStorage();
      if (!store) return;
      try { store.setItem(key, value); } catch (_error) { /* remembering is a convenience, not a contract */ }
    }

    function readSeenAt() {
      if (seenAt === null) seenAt = readStored(SEEN_STORAGE_KEY);
      return seenAt;
    }
    function readSeenBySession() {
      if (seenBySession !== null) return seenBySession;
      try {
        var parsed = JSON.parse(readStored(SESSION_SEEN_STORAGE_KEY) || '{}');
        seenBySession = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
      } catch (_error) {
        seenBySession = {};
      }
      return seenBySession;
    }

    function runtimeBridge() {
      var shell = windowRef.jennyShell;
      return shell && shell.sessionRuntime ? shell.sessionRuntime : null;
    }
    function buildDigest() {
      return model().buildAwayDigest({
        work: page,
        seenAt: readSeenAt(),
        seenBySession: readSeenBySession(),
        now: Date.now(),
        sessions: state.sessions,
        limit: limit,
      });
    }

    function publish(notify) {
      published = Object.freeze({
        digest: buildDigest(),
        loading: loading,
        readFailed: readFailed,
        hasRead: hasRead,
      });
      state.awayDigest = published;
      if (notify) {
        if (typeof callbacks.onChanged === 'function') callbacks.onChanged();
        listeners.slice().forEach(function call(fn) { fn(); });
      }
      return published;
    }
    function subscribe(fn) {
      if (typeof fn !== 'function') return function noop() {};
      listeners.push(fn);
      return function unsubscribe() { listeners = listeners.filter(function keep(entry) { return entry !== fn; }); };
    }
    function writeSessionCursor(sessionId, atIso) {
      if (!sessionId || !atIso) return false;
      var current = readSeenBySession()[sessionId];
      if (current && !isAfter(atIso, current)) return false;
      var latest = published.digest.latestTerminalBySession;
      var next = {};
      Object.keys(readSeenBySession()).forEach(function keep(id) {
        if (latest[id] || !isAfter(pageReadAt, readSeenBySession()[id])) next[id] = readSeenBySession()[id];
      });
      next[sessionId] = atIso;
      seenBySession = next;
      writeStored(SESSION_SEEN_STORAGE_KEY, JSON.stringify(next));
      return true;
    }
    function noteSessionOpened(sessionId) {
      if (disposed) return false;
      var wrote = writeSessionCursor(String(sessionId || ''), new Date().toISOString());
      if (wrote) publish(true);
      return wrote;
    }
    function visibleChatSession() {
      var activeView = state.ui && typeof state.ui.activeView === 'string' ? state.ui.activeView : '';
      if ((activeView && activeView !== 'chat') || (documentRef && documentRef.visibilityState === 'hidden')) return '';
      return typeof state.currentSessionId === 'string' ? state.currentSessionId : '';
    }
    function noteWatched() {
      var sessionId = visibleChatSession();
      if (sessionId) watchedAt[sessionId] = Date.now();
    }
    function commitWatched(notify) {
      var wrote = false;
      Object.keys(watchedAt).forEach(function commit(sessionId) {
        if (writeSessionCursor(sessionId, new Date(watchedAt[sessionId]).toISOString())) wrote = true;
      });
      watchedAt = {};
      if (wrote && notify) publish(true);
      return wrote;
    }

    function refresh() {
      if (disposed) return Promise.resolve(false);
      if (inFlight) return inFlight;
      var runtime = runtimeBridge(), requestedAt = new Date().toISOString();
      if (!runtime || typeof runtime.getSnapshot !== 'function') return Promise.resolve(false);
      loading = true;
      inFlight = Promise.resolve().then(function readPage() {
        return runtime.getSnapshot({ limit: SNAPSHOT_LIMIT, cursor: null });
      }).then(function readResult(result) {
        if (disposed) return false;
        if (!result || result.ok !== true) throw new Error(String(result && result.error || 'runtime_snapshot_refused'));
        page = Array.isArray(result.work) ? result.work : [];
        pageReadAt = requestedAt;
        hasRead = true;
        readFailed = false;
        limit = model().DEFAULT_ROW_LIMIT;
        loading = false;
        if (usageFailed) { usagePromise = null; usageFailed = false; }
        publish(false);
        noteWatched();
        commitWatched(false);
        publish(true);
        return true;
      }).catch(function readError(error) {
        if (disposed) return false;
        loading = false;
        readFailed = true;
        log('WARN', 'chat.away_digest_read_failed', { message: String(error && error.message || error || '') });
        publish(true);
        return false;
      }).finally(function clearRead() {
        inFlight = null;
      });
      // Loading is not in any render key and a chrome pass may be the caller:
      // the page in hand is republished quietly, listeners hear the result.
      publish(false);
      return inFlight;
    }

    function markAllSeen() {
      if (disposed || !published.digest.newestAt) return Promise.resolve(false);
      seenAt = published.digest.newestAt;
      writeStored(SEEN_STORAGE_KEY, seenAt);
      publish(true);
      return Promise.resolve(true); // no read: a read belongs to an arrival, not a click
    }

    function showAll() {
      if (disposed) return false;
      limit = Infinity;
      publish(true);
      return true;
    }

    function panelVisible() {
      var activeView = state.ui && typeof state.ui.activeView === 'string' ? state.ui.activeView : '';
      if (activeView && activeView !== 'chat') return false;
      var node = documentRef && documentRef.getElementById('conversationGroups');
      while (node) {
        if (node.hidden === true) return false;
        if (typeof node.getAttribute === 'function' && node.getAttribute('aria-hidden') === 'true') return false;
        if (node.classList && (node.classList.contains('panel-collapsed') || node.classList.contains('panel-none'))) return false;
        node = node.parentElement;
      }
      return true;
    }

    function onChromePass() {
      if (disposed) return;
      var sessionId = visibleChatSession();
      if (sessionId !== lastChromeSession) {
        lastChromeSession = sessionId;
        commitWatched(true);
      }
      noteWatched();
      var visible = panelVisible();
      if (visible !== lastPanelVisible) {
        lastPanelVisible = visible;
        if (visible) refresh();
      }
    }

    function handleDocumentVisibility() {
      if (disposed || !documentRef.visibilityState) return;
      if (documentRef.visibilityState === 'hidden') { commitWatched(true); return; }
      if ((state.ui && state.ui.activeView === 'home') || panelVisible()) refresh();
    }

    function warnTokens(workId, error) {
      if (tokenWarnings.has(workId)) return;
      tokenWarnings.add(workId);
      log('WARN', 'chat.away_digest_tokens_failed', {
        workId: workId,
        message: String(error && error.message || error || ''),
      });
    }

    function readWorkStream(workId) {
      if (workStreamPromises.has(workId)) return workStreamPromises.get(workId);
      var runtime = runtimeBridge();
      if (!runtime || typeof runtime.getWork !== 'function') {
        warnTokens(workId, new Error('runtime_work_unavailable'));
        var missing = Promise.resolve(null);
        workStreamPromises.set(workId, missing);
        return missing;
      }
      var promise = Promise.resolve().then(function readWork() {
        return runtime.getWork({ work_id: workId });
      }).then(function workResult(result) {
        var streamId = result && result.ok === true && result.work && result.work.attempt
          ? String(result.work.attempt.stream_id || '') : '';
        if (!streamId) throw new Error(String(result && result.error || 'runtime_work_refused'));
        return streamId;
      }).catch(function workError(error) {
        warnTokens(workId, error);
        return null;
      });
      workStreamPromises.set(workId, promise);
      return promise;
    }

    function readUsage() {
      if (usagePromise) return usagePromise;
      var usage = windowRef.jennyShell && windowRef.jennyShell.usage;
      if (!usage || typeof usage.getSnapshot !== 'function') return Promise.reject(new Error('usage_bridge_unavailable'));
      usagePromise = Promise.resolve().then(function readUsagePage() {
        return usage.getSnapshot({ limit: USAGE_LIMIT });
      }).then(function usageResult(result) {
        if (!result || !Array.isArray(result.recent_turns)) throw new Error('usage_snapshot_refused');
        var byStream = new Map();
        result.recent_turns.forEach(function index(record) {
          var streamId = String(record && record.stream_id || '');
          if (streamId && !byStream.has(streamId)) byStream.set(streamId, record);
        });
        return byStream;
      }).catch(function usageError(error) {
        usageFailed = true; // retained until the next arrival read
        throw error;
      });
      return usagePromise;
    }

    function readTokens(row) {
      if (disposed || !row || !row.workId) return Promise.resolve(null);
      var workId = String(row.workId);
      if (tokenValues.has(workId)) return Promise.resolve(tokenValues.get(workId));
      return readWorkStream(workId).then(function withStream(streamId) {
        if (!streamId) return null;
        return readUsage().then(function withUsage(usageByStream) {
          var tokens = usageByStream ? model().tokensForStream(usageByStream, streamId) : null;
          tokenValues.set(workId, tokens);
          return tokens;
        }).catch(function tokensError(error) {
          warnTokens(workId, error);
          return null;
        });
      });
    }

    function dispose() {
      if (disposed) return;
      disposed = true;
      if (documentRef) documentRef.removeEventListener('visibilitychange', handleDocumentVisibility);
      commitWatched(false);
      listeners = [];
      usagePromise = null;
      workStreamPromises.clear();
      tokenValues.clear();
      tokenWarnings.clear();
    }
    publish(false);
    if (documentRef) documentRef.addEventListener('visibilitychange', handleDocumentVisibility);
    return { refresh: refresh, markAllSeen: markAllSeen, noteSessionOpened: noteSessionOpened,
      onChromePass: onChromePass, showAll: showAll, readTokens: readTokens, subscribe: subscribe,
      getSnapshot: function getSnapshot() { return published; }, dispose: dispose };
  }

  function createAwayDigestWidget(deps) {
    var options = deps && typeof deps === 'object' ? deps : {};
    var reader = options.reader;
    var actionButton = options.actionButton;
    var tooltip = options.tooltip;
    var callbacks = options.callbacks && typeof options.callbacks === 'object' ? options.callbacks : {};
    var documentRef = options.documentRef || globalThis.document || null;
    var setTimeoutImpl = options.setTimeoutImpl || globalThis.setTimeout;
    var clearTimeoutImpl = options.clearTimeoutImpl || globalThis.clearTimeout;
    var bodyTeardown = null;

    function element(tag, className, content) {
      var node = documentRef.createElement(tag);
      if (className) node.className = className;
      if (content !== undefined) node.textContent = content;
      return node;
    }

    function control(parent, spec) {
      if (typeof actionButton !== 'function') return null;
      var wrapper = documentRef.createElement('span');
      wrapper.innerHTML = actionButton({
        plain: true,
        className: spec.className,
        label: spec.label,
        title: spec.title,
        disabled: spec.disabled === true,
        dataset: { 'digest-action': spec.action },
      });
      var node = wrapper.firstElementChild;
      if (!node) return null;
      node.addEventListener('click', spec.onClick);
      parent.appendChild(node);
      return node;
    }

    function openRow(row) {
      return Promise.resolve().then(function open() {
        if (typeof callbacks.openSession === 'function') return callbacks.openSession(row.sessionId);
        return undefined;
      }).then(function opened() {
        reader.noteSessionOpened(row.sessionId);
      }).catch(function openFailed(error) {
        if (typeof callbacks.appendClientLog === 'function') {
          callbacks.appendClientLog('ERROR', 'chat.away_digest_open_failed', {
            sessionId: row.sessionId,
            message: String(error && error.message || error || ''),
          });
        }
        if (typeof callbacks.showComposerActionError === 'function') {
          callbacks.showComposerActionError(error, jt('chat.awayDigest.openFailedTitle', 'Open Failed'));
        }
      });
    }

    function outcomeLabel(outcome) {
      if (outcome === 'failed') return jt('chat.awayDigest.outcomeFailed', 'Failed');
      if (outcome === 'cancelled') return jt('chat.awayDigest.outcomeCancelled', 'Cancelled');
      return jt('chat.awayDigest.outcomeCompleted', 'Finished');
    }
    function renderMeta(row) {
      var meta = element('span', 'away-digest__meta');
      if (row.outcome !== 'completed') {
        var outcome = element('span', 'away-digest__outcome', outcomeLabel(row.outcome));
        outcome.classList.add('away-digest__outcome--' + row.outcome);
        meta.appendChild(outcome);
        meta.appendChild(documentRef.createTextNode(META_SEPARATOR));
      }
      var when = element('span', 'away-digest__time', relativeTime(row.finishedAt));
      var exact = new Date(row.finishedAt);
      when.title = Number.isNaN(exact.valueOf()) ? row.finishedAt : exact.toLocaleString(localeTag());
      meta.appendChild(when);
      return meta;
    }

    function bindBody(body) {
      if (!tooltip || typeof tooltip.show !== 'function') return;
      if (body.dataset.awayDigestBound === '1' && BODY_TEARDOWNS.get(body) === bodyTeardown) return;
      var prior = BODY_TEARDOWNS.get(body);
      if (prior) prior();
      if (bodyTeardown) bodyTeardown();
      body.dataset.awayDigestBound = '1';
      var timer = null;
      var timerEl = null;
      var hoveredEl = null;
      var focusedEl = null;
      function openControl(target) {
        var el = target && typeof target.closest === 'function'
          ? target.closest('[data-digest-action="open"]') : null;
        return el && body.contains(el) ? el : null;
      }
      function cancel(el) {
        if (el && timerEl !== el) return;
        timerEl = null;
        if (timer !== null) {
          clearTimeoutImpl(timer);
          timer = null;
        }
      }
      function start(el) {
        cancel();
        timerEl = el;
        timer = setTimeoutImpl(function fire() {
          timer = null;
          timerEl = null;
          var rowEl = el.closest('[data-digest-key]');
          var rowKey = rowEl ? rowEl.dataset.digestKey : '';
          var row = reader.getSnapshot().digest.rows.find(function find(candidate) {
            return candidate.key === rowKey;
          });
          if (!row || !el.isConnected) return;
          Promise.resolve(reader.readTokens(row)).catch(function noTokens() { return null; }).then(function show(tokens) {
            if ((hoveredEl !== el && focusedEl !== el) || !el.isConnected) return;
            var startedLine = el.dataset.tooltip || jt('chat.awayDigest.started', 'Started {when}', {
              when: relativeTime(row.startedAt),
            });
            var tokenLine = tokens ? '\n' + jt('chat.awayDigest.tokens', '{input} in · {output} out tokens', {
              input: formatCount(tokens.input), output: formatCount(tokens.output),
            }) : '';
            tooltip.show(el, startedLine + tokenLine);
          });
        }, 400);
      }
      function handleMouseOver(event) {
        var el = openControl(event.target);
        if (!el || (event.relatedTarget && el.contains(event.relatedTarget))) return;
        hoveredEl = el;
        start(el);
      }
      function handleMouseOut(event) {
        var el = openControl(event.target);
        if (!el || (event.relatedTarget && el.contains(event.relatedTarget))) return;
        hoveredEl = null;
        if (focusedEl !== el) cancel(el);
      }
      function handleFocusIn(event) {
        var el = openControl(event.target);
        if (el) { focusedEl = el; start(el); }
      }
      function handleFocusOut(event) {
        var el = openControl(event.target);
        if (el) { focusedEl = null; if (hoveredEl !== el) cancel(el); }
      }
      body.addEventListener('mouseover', handleMouseOver);
      body.addEventListener('mouseout', handleMouseOut);
      body.addEventListener('focusin', handleFocusIn);
      body.addEventListener('focusout', handleFocusOut);
      var teardown = function teardown() {
        body.removeEventListener('mouseover', handleMouseOver);
        body.removeEventListener('mouseout', handleMouseOut);
        body.removeEventListener('focusin', handleFocusIn);
        body.removeEventListener('focusout', handleFocusOut);
        hoveredEl = null;
        focusedEl = null;
        cancel();
        delete body.dataset.awayDigestBound;
        if (BODY_TEARDOWNS.get(body) === teardown) BODY_TEARDOWNS.delete(body);
        if (bodyTeardown === teardown) bodyTeardown = null;
      };
      bodyTeardown = teardown;
      BODY_TEARDOWNS.set(body, teardown);
    }

    function render(body) {
      if (!documentRef) documentRef = body.ownerDocument;
      bindBody(body);
      var snapshot = reader.getSnapshot();
      var digest = snapshot.digest;
      var renderKey = JSON.stringify([snapshot.readFailed, snapshot.hasRead, digest.unseenCount,
        digest.runningCount, digest.truncated, digest.rows.map(function key(row) {
          return [row.key, row.sessionTitle, row.sessionGone, row.outcome, row.finishedAt, row.olderThanRetention];
        })]);
      if (body.dataset.awayDigestRenderKey === renderKey) return;
      if (documentRef.activeElement && body.contains(documentRef.activeElement)) {
        body.tabIndex = -1;
        body.focus();
      }
      body.textContent = '';

      if (digest.runningCount > 0) {
        body.appendChild(element('div', 'away-digest__progress', jtn('chat.awayDigest.inProgress', digest.runningCount,
          { count: digest.runningCount }, '{count} still in progress', '{count} still in progress')));
      }
      if (snapshot.readFailed) {
        var error = element('div', 'away-digest__error', jt('chat.awayDigest.readFailed', "Couldn't read the runtime list."));
        control(error, { action: 'retry', className: 'away-digest__retry',
          label: jt('chat.awayDigest.retry', 'Retry'), onClick: function retry() { reader.refresh(); } });
        body.appendChild(error);
      }
      if (!digest.rows.length && !snapshot.readFailed) {
        body.appendChild(element('div', 'dashboard-empty-note',
          jt('chat.awayDigest.empty', 'Nothing finished since you last looked.')));
        body.dataset.awayDigestRenderKey = renderKey;
        return;
      }

      digest.rows.forEach(function renderRow(row) {
        var rowEl = element('div', 'away-digest__row');
        rowEl.dataset.digestKey = row.key;
        if (row.sessionGone) {
          var gone = element('span', 'away-digest__title', row.sessionTitle);
          gone.classList.add('away-digest__title--gone');
          rowEl.appendChild(gone);
        } else {
          var title = control(rowEl, { action: 'open', className: 'away-digest__title', label: row.sessionTitle,
            title: jt('chat.awayDigest.openTitle', 'Open this conversation'), onClick: function open() { openRow(row); } });
          if (title) {
            title.dataset.tooltip = jt('chat.awayDigest.started', 'Started {when}', { when: relativeTime(row.startedAt) });
            title.removeAttribute('title');
          }
        }
        rowEl.appendChild(renderMeta(row));
        body.appendChild(rowEl);
      });

      if (digest.rows.some(function old(row) { return row.olderThanRetention; })) {
        body.appendChild(element('div', 'away-digest__note', jt('chat.awayDigest.retentionNote',
          'Older than 30 days; Jenny may keep only the outcome.')));
      }
      if (digest.truncated) {
        control(body, { action: 'show-all', className: 'away-digest__show-all',
          label: jt('chat.awayDigest.showAll', 'Show all {count}', { count: formatCount(digest.unseenCount) }),
          onClick: function showAll() { reader.showAll(); } });
      }
      control(body, { action: 'seen', className: 'away-digest__seen',
        label: jt('chat.awayDigest.markAllSeen', 'Mark all seen'),
        title: jt('chat.awayDigest.markAllSeenTitle', 'Hide these until something new finishes'),
        disabled: digest.rows.length === 0,
        onClick: function seen() { body.tabIndex = -1; body.focus(); reader.markAllSeen(); } });
      body.dataset.awayDigestRenderKey = renderKey;
    }

    return { id: 'away-digest', title: jt('chat.awayDigest.title', 'While you were away'), slot: 'main', render: render,
      // The registry has no dispose hook; the manager that built this widget calls it.
      dispose: function dispose() { if (bodyTeardown) bodyTeardown(); } };
  }

  return { createAwayDigestReader: createAwayDigestReader, createAwayDigestWidget: createAwayDigestWidget };
});
