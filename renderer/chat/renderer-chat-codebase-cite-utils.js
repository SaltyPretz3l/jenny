/* renderer/chat/renderer-chat-codebase-cite-utils.js
 * Tier-3 keyword code-search context (grounded `file:line` citations) — renderer half.
 * This is plain keyword/substring code search, NOT embeddings/semantic Q&A.
 *
 * Post-processes settled assistant message markdown to turn `path/to/file.js:42`
 * citations (which the backend codebase-grounding context primes the model to
 * emit) into clickable links.
 *
 * Click behavior: dispatches a CANCELABLE CustomEvent('ide:open-file-at-line',
 * {detail:{path,line,column}}). The production consumer is
 * renderer-chat-path-open.js (W1-4): it preventDefault()s to CLAIM the
 * navigation, switches to the Workspace IDE, and opens the file at line via
 * the IDE controller's openFileAtLine seam. Any claiming listener MUST
 * preventDefault() to avoid a double-open; when nothing claims (rootless
 * shell, unsafe path, listener absent) the click falls through to the OS
 * fallback below — window.jennyShell.workspaceFs.openInDefaultApp({ path }).
 *
 * This module self-installs a MutationObserver on #chatTimeline and touches no
 * other file: enhancement is purely imperative DOM work that runs AFTER the
 * markdown sanitizer (so it is unaffected by DOMPurify's data-attr stripping).
 * Gated on the workspace_codebase_context feature flag (default ON —
 * services/feature-flags.js), read once at boot via
 * window.jennyShell.features.getState(); the observer is only attached
 * when the flag is on, so a disabled feature costs nothing.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  var api = factory();
  root.rendererChatCodebaseCiteUtils = api;
  if (api && typeof api.installSelf === 'function') {
    api.installSelf(root);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var CITE_HREF_PREFIX = '#codebase:';
  var CITE_LINK_CLASS = 'codebase-cite-link';
  var ENHANCED_ATTR = 'data-codebase-cite-enhanced';
  var MAX_PATH_LENGTH = 512;
  var MAX_LINE = 100000000;

  // Source-ish extensions a citation path may end with. This is a deliberate
  // SUBSET of the backend codebase-context-utils TEXT_EXTENSIONS: the backend
  // additionally scans `.m`/`.mm` (Objective-C), which are intentionally NOT
  // linkified here because the 1-char `.m` extension produces false positives
  // in prose (e.g. "by 9 a.m:30"); such citations still render as plain text.
  // Keep the two lists in sync for every OTHER extension (the backend also
  // omits `.env` — see the note there).
  var EXTENSIONS = [
    'js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'py', 'json', 'jsonc',
    'md', 'markdown', 'css', 'scss', 'sass', 'less', 'html', 'htm',
    'yml', 'yaml', 'toml', 'ini', 'cfg', 'conf',
    'sh', 'bash', 'zsh', 'ps1', 'bat', 'txt', 'sql', 'graphql', 'gql',
    'go', 'rs', 'java', 'kt', 'rb', 'php', 'c', 'h', 'cpp', 'hpp',
    'cc', 'cs', 'swift', 'vue', 'svelte', 'astro', 'xml',
  ];

  // Match `path/to/file.ext:line[:col]`. The negative lookbehind keeps us from
  // starting mid-path or inside a URL (e.g. https://host/app.js:80 — the chars
  // before each path segment are '/' or ':' and so are excluded).
  function buildCitationRegExp() {
    return new RegExp(
      '(?<![\\w/:.@\\\\-])'
      + '((?:[\\w.-]+[\\\\/])*[\\w.-]+\\.(?:' + EXTENSIONS.join('|') + '))'
      + ':(\\d{1,8})'
      + '(?::(\\d{1,8}))?',
      'gi'
    );
  }

  function normalizeRelPath(value) {
    return String(value || '').trim().replace(/\\/g, '/');
  }

  // Reject anything that is not a plausible, contained workspace-relative path.
  // Uses charCode checks (no regex escape literals) so the source carries no
  // control bytes. Note: this is a best-effort renderer guard — the trusted
  // boundary is the main-process workspaceFs path policy (realpath containment
  // + existence check), which is authoritative for what actually opens.
  function isSafeRelPath(value) {
    var p = String(value || '');
    if (!p || p.length > MAX_PATH_LENGTH) {
      return false;
    }
    for (var i = 0; i < p.length; i += 1) {
      var code = p.charCodeAt(i);
      // Reject C0 controls, DEL, and any whitespace (incl. space at 0x20) so the
      // find and parse sides agree on the legal path alphabet.
      if (code <= 0x20 || code === 0x7f) {
        return false;
      }
    }
    if (p.charAt(0) === '/' || /^[a-zA-Z]:/.test(p)) {
      return false; // absolute / drive-rooted
    }
    var segments = p.split('/');
    for (var s = 0; s < segments.length; s += 1) {
      if (segments[s] === '..') {
        return false; // no parent-escape
      }
    }
    return true;
  }

  function clampLine(value) {
    var n = parseInt(value, 10);
    if (!Number.isFinite(n) || n < 1) {
      return null;
    }
    return Math.min(n, MAX_LINE);
  }

  /**
   * Find file:line citations in a plain-text string. Returns an array of
   * { index, length, path, line, column } describing each match's span (so a
   * caller can splice clickable links in place). Unsafe paths are skipped.
   */
  function findCodebaseCitations(text) {
    var source = String(text == null ? '' : text);
    if (!source) {
      return [];
    }
    var regex = buildCitationRegExp();
    var matches = [];
    var match;
    while ((match = regex.exec(source)) !== null) {
      var rawPath = normalizeRelPath(match[1]);
      var line = clampLine(match[2]);
      var column = match[3] ? clampLine(match[3]) : null;
      if (line == null || !isSafeRelPath(rawPath)) {
        continue;
      }
      matches.push({
        index: match.index,
        length: match[0].length,
        path: rawPath,
        line: line,
        column: column,
      });
    }
    return matches;
  }

  function buildCodebaseCiteHref(relPath, line, column) {
    var href = CITE_HREF_PREFIX + normalizeRelPath(relPath) + ':' + String(line);
    if (column) {
      href += ':' + String(column);
    }
    return href;
  }

  function safeDecode(value) {
    try {
      return decodeURIComponent(value);
    } catch (_error) {
      return value;
    }
  }

  function resolveHash(rawHref, currentHref) {
    var href = String(rawHref || '').trim();
    if (!href) {
      return '';
    }
    if (href.charAt(0) === '#') {
      return href;
    }
    var baseHref = String(currentHref || '').trim();
    if (!baseHref || typeof URL !== 'function') {
      return '';
    }
    try {
      var current = new URL(baseHref);
      var target = new URL(href, current.href);
      if (
        target.origin !== current.origin
        || target.pathname !== current.pathname
        || target.search !== current.search
      ) {
        return '';
      }
      return target.hash || '';
    } catch (_error) {
      return '';
    }
  }

  /**
   * Parse a `#codebase:<path>:<line>[:<col>]` href into { path, line, column },
   * or null if it is not a (safe) codebase citation href.
   */
  function parseCodebaseCiteHref(rawHref, currentHref) {
    var hash = resolveHash(rawHref, currentHref);
    if (!hash || hash.indexOf(CITE_HREF_PREFIX) !== 0) {
      return null;
    }
    var body = safeDecode(hash.slice(CITE_HREF_PREFIX.length));
    var parts = body.split(':');
    if (parts.length < 2) {
      return null;
    }
    var relPath = normalizeRelPath(parts[0]);
    var line = clampLine(parts[1]);
    var column = parts.length >= 3 ? clampLine(parts[2]) : null;
    if (line == null || !isSafeRelPath(relPath)) {
      return null;
    }
    return { path: relPath, line: line, column: column };
  }

  function createCodebaseCiteController(deps) {
    var options = deps || {};
    var doc = options.document || (typeof document !== 'undefined' ? document : null);
    var win = options.window || (doc && doc.defaultView) || (typeof window !== 'undefined' ? window : null);
    var chatTimeline = options.chatTimeline || null;
    var getWorkspaceFs = typeof options.getWorkspaceFs === 'function'
      ? options.getWorkspaceFs
      : function defaultGetWorkspaceFs() { return null; };
    var isEnabled = typeof options.isEnabled === 'function'
      ? options.isEnabled
      : function defaultIsEnabled() { return true; };
    var appendClientLog = typeof options.appendClientLog === 'function'
      ? options.appendClientLog
      : function noopAppendClientLog() {};
    // Optional user-facing notifier (default noop). The shell's toast surface is
    // injected into controllers rather than exposed globally, so this seam lets
    // a future caller wire a real toast; today the self-contained anchor cue
    // below (title tooltip + data-codebase-cite-error stamp) is the live signal.
    var notifyError = typeof options.notifyError === 'function'
      ? options.notifyError
      : function noopNotifyError() {};

    var disposed = false;
    var observer = null;
    var scheduled = false;
    var scheduledHandle = null;
    var scheduledWithAnimationFrame = false;
    var pendingEnhanceRoots = new Set();
    var detachClick = null;

    function isInsideSkippableNode(node) {
      var el = node && node.parentNode;
      while (el && el !== chatTimeline) {
        var tag = el.tagName;
        if (tag === 'A' || tag === 'PRE') {
          return true; // never linkify inside existing links or fenced code blocks
        }
        el = el.parentNode;
      }
      return false;
    }

    function buildCiteAnchor(matchText, citation) {
      var anchor = doc.createElement('a');
      anchor.className = CITE_LINK_CLASS;
      anchor.setAttribute('href', buildCodebaseCiteHref(citation.path, citation.line, citation.column));
      anchor.setAttribute(
        'title',
        'Open ' + citation.path + ' at line ' + citation.line
      );
      anchor.textContent = matchText;
      return anchor;
    }

    // Replace a single text node with [text?, <a>, text?, <a>, ...] for each
    // citation it contains. Returns true if any link was injected.
    function enhanceTextNode(textNode) {
      var value = textNode.nodeValue;
      var citations = findCodebaseCitations(value);
      if (citations.length === 0) {
        return false;
      }
      var fragment = doc.createDocumentFragment();
      var cursor = 0;
      for (var i = 0; i < citations.length; i += 1) {
        var c = citations[i];
        if (c.index > cursor) {
          fragment.appendChild(doc.createTextNode(value.slice(cursor, c.index)));
        }
        var matchText = value.slice(c.index, c.index + c.length);
        fragment.appendChild(buildCiteAnchor(matchText, c));
        cursor = c.index + c.length;
      }
      if (cursor < value.length) {
        fragment.appendChild(doc.createTextNode(value.slice(cursor)));
      }
      textNode.parentNode.replaceChild(fragment, textNode);
      return true;
    }

    function enhanceBubble(bubble) {
      if (!bubble || disposed || bubble.getAttribute(ENHANCED_ATTR) === '1') {
        return false;
      }
      // Collect text nodes first; the walk must not be disturbed by the
      // replacements we perform afterward.
      var walker = doc.createTreeWalker(bubble, 4 /* NodeFilter.SHOW_TEXT */, null);
      var pending = [];
      var node = walker.nextNode();
      while (node) {
        if (node.nodeValue && /[\w.-]+\.[a-z0-9]+:\d/i.test(node.nodeValue) && !isInsideSkippableNode(node)) {
          pending.push(node);
        }
        node = walker.nextNode();
      }
      var changed = false;
      for (var i = 0; i < pending.length; i += 1) {
        if (enhanceTextNode(pending[i])) {
          changed = true;
        }
      }
      // Stamp synchronously so the observer's async callback skips this bubble
      // (including the mutations our own link injection just produced).
      bubble.setAttribute(ENHANCED_ATTR, '1');
      return changed;
    }

    function isStreamingArticle(bubble) {
      var article = typeof bubble.closest === 'function' ? bubble.closest('.chat-entry') : null;
      return Boolean(article && article.getAttribute('data-message-status') === 'streaming');
    }

    function enhanceWithin(rootNode) {
      if (disposed || !rootNode || !isEnabled() || typeof rootNode.querySelectorAll !== 'function') {
        return 0;
      }
      var bubbles = Array.from(rootNode.querySelectorAll(
        '[data-message-role="assistant"] .chat-bubble-markdown:not([' + ENHANCED_ATTR + '="1"])'
      ));
      if (
        rootNode.matches
        && rootNode.matches('.chat-bubble-markdown:not([' + ENHANCED_ATTR + '="1"])')
        && rootNode.closest?.('[data-message-role="assistant"]')
      ) {
        bubbles.unshift(rootNode);
      }
      var count = 0;
      for (var i = 0; i < bubbles.length; i += 1) {
        if (isStreamingArticle(bubbles[i])) {
          continue; // wait until the message settles
        }
        if (enhanceBubble(bubbles[i])) {
          count += 1;
        }
      }
      return count;
    }

    function enhanceAll() {
      return enhanceWithin(chatTimeline);
    }

    function collectMutationRoots(records) {
      var sourceRecords = Array.isArray(records) ? records : [];
      for (var recordIndex = 0; recordIndex < sourceRecords.length; recordIndex += 1) {
        var record = sourceRecords[recordIndex];
        var addedNodes = Array.from(record && record.addedNodes || []);
        if (!addedNodes.length && record && record.target) addedNodes.push(record.target);
        for (var nodeIndex = 0; nodeIndex < addedNodes.length; nodeIndex += 1) {
          var node = addedNodes[nodeIndex];
          var element = node && node.nodeType === 1 ? node : node && node.parentElement;
          if (!element) continue;
          pendingEnhanceRoots.add(element.closest?.('.chat-entry') || element);
          if (pendingEnhanceRoots.size > 32) {
            pendingEnhanceRoots.clear();
            pendingEnhanceRoots.add(chatTimeline);
            return;
          }
        }
      }
    }

    function scheduleEnhanceAll(records) {
      collectMutationRoots(records);
      if (scheduled || disposed) {
        return;
      }
      scheduled = true;
      var run = function runScheduledEnhance() {
        scheduled = false;
        scheduledHandle = null;
        var roots = pendingEnhanceRoots.size ? Array.from(pendingEnhanceRoots) : [chatTimeline];
        pendingEnhanceRoots.clear();
        for (var index = 0; index < roots.length; index += 1) {
          try { enhanceWithin(roots[index]); } catch (_error) { /* isolate one malformed subtree */ }
        }
      };
      if (win && typeof win.requestAnimationFrame === 'function') {
        scheduledWithAnimationFrame = true;
        scheduledHandle = win.requestAnimationFrame(run);
      } else if (win && typeof win.setTimeout === 'function') {
        scheduledWithAnimationFrame = false;
        scheduledHandle = win.setTimeout(run, 0);
      } else {
        run();
      }
    }

    // Map a workspaceFs open failure to a short, human-readable cue. Keys off the
    // structured CMP-WORKSPACEFS-* error code (the renderer convention — cf.
    // renderer/shared/error-intake.js and renderer-ide-tree.js — rather than
    // sniffing the human-prose message, which never carries the symbolic token).
    // Codes are mirrored from services/backend/error-codes.js WORKSPACE_FS_ERROR_CODES
    // because this UMD module cannot import services. Falls back to a generic
    // line for any unrecognized / absent code (e.g. if the code did not survive
    // the IPC boundary), so the cue is always useful.
    function friendlyOpenError(relPath, error) {
      var code = String((error && (error.error_code || error.code)) || '');
      if (code === 'CMP-WORKSPACEFS-0004') { // NOT_FOUND
        return 'Couldn’t open ' + relPath + ' — file not found.';
      }
      if (code === 'CMP-WORKSPACEFS-0003') { // PATH_OUTSIDE_ROOT
        return 'Couldn’t open ' + relPath + ' — outside the workspace.';
      }
      if (code === 'CMP-WORKSPACEFS-0061') { // OPEN_UNAVAILABLE
        return 'Couldn’t open ' + relPath + ' from here.';
      }
      return 'Couldn’t open ' + relPath + '.';
    }

    // Self-contained, CSS-free feedback at the point of interaction: stamp the
    // clicked link so a dead citation visibly explains itself on hover (title)
    // and exposes a styling hook (data-codebase-cite-error). Also fire the
    // optional notifyError seam for any wired toast surface.
    function markCiteError(anchor, message) {
      notifyError(message, {});
      if (anchor && typeof anchor.setAttribute === 'function') {
        anchor.setAttribute('data-codebase-cite-error', '1');
        anchor.setAttribute('title', message);
      }
    }

    function openCitation(citation, anchor) {
      if (!citation) {
        return;
      }
      // Clear any prior failure cue so a retry that now succeeds doesn't keep a
      // stale "couldn't open" tooltip on the link.
      if (anchor && typeof anchor.removeAttribute === 'function') {
        anchor.removeAttribute('data-codebase-cite-error');
      }
      var handled = false;
      try {
        if (win && typeof win.CustomEvent === 'function' && typeof win.dispatchEvent === 'function') {
          var event = new win.CustomEvent('ide:open-file-at-line', {
            detail: { path: citation.path, line: citation.line, column: citation.column || null },
            bubbles: true,
            cancelable: true,
          });
          // dispatchEvent returns false ONLY when a listener called
          // preventDefault, i.e. the IDE claimed the in-editor navigation. Any
          // future in-editor listener MUST preventDefault to avoid a double-open.
          handled = win.dispatchEvent(event) === false;
        }
      } catch (_error) {
        handled = false;
      }
      appendClientLog('INFO', 'chat.codebase_cite_open', {
        path: citation.path,
        line: citation.line,
        handled: handled,
      });
      if (handled) {
        return;
      }
      // No in-editor listener claimed it — fall back to opening the real file
      // via the OS. (isSafeRelPath already vetted the path; the main process
      // re-validates containment + existence.)
      var fsApi = getWorkspaceFs();
      if (!fsApi || typeof fsApi.openInDefaultApp !== 'function') {
        appendClientLog('WARN', 'chat.codebase_cite_open_unavailable', { path: citation.path });
        markCiteError(anchor, 'Couldn’t open ' + citation.path + ' from here.');
        return;
      }
      // One failure handler for both a rejected promise and a synchronous throw
      // (the call stays synchronous so the open fires this tick).
      var reportFailure = function reportFailure(error) {
        appendClientLog('WARN', 'chat.codebase_cite_open_failed', {
          path: citation.path,
          message: String((error && error.message) || error || ''),
        });
        markCiteError(anchor, friendlyOpenError(citation.path, error));
      };
      try {
        Promise.resolve(fsApi.openInDefaultApp({ path: citation.path })).catch(reportFailure);
      } catch (error) {
        reportFailure(error);
      }
    }

    function findCiteAnchor(target) {
      if (!target || typeof target.closest !== 'function') {
        return null;
      }
      var anchor = target.closest('a[href]');
      if (!anchor || !chatTimeline) {
        return null;
      }
      if (typeof chatTimeline.contains === 'function' && !chatTimeline.contains(anchor)) {
        return null;
      }
      if (typeof anchor.closest !== 'function' || !anchor.closest('.chat-bubble-markdown')) {
        return null;
      }
      return anchor;
    }

    function handleClick(event) {
      if (disposed) {
        return;
      }
      var anchor = findCiteAnchor(event && event.target);
      if (!anchor) {
        return;
      }
      var citation = parseCodebaseCiteHref(
        anchor.getAttribute('href'),
        doc && doc.location && doc.location.href
      );
      if (!citation) {
        return; // not ours — let other handlers / default behavior proceed
      }
      event.preventDefault();
      if (typeof event.stopPropagation === 'function') {
        event.stopPropagation();
      }
      openCitation(citation, anchor);
    }

    function attach() {
      if (disposed || !chatTimeline) {
        return function noopDetach() {};
      }
      chatTimeline.addEventListener('click', handleClick);
      detachClick = function detach() {
        chatTimeline.removeEventListener('click', handleClick);
      };
      if (win && typeof win.MutationObserver === 'function') {
        observer = new win.MutationObserver(function onMutations(records) {
          var actionable = Array.from(records || []).filter(function isActionable(record) {
            return record.type !== 'attributes'
              || (
                record.attributeName === 'data-message-status'
                && record.target
                && record.target.getAttribute('data-message-status') !== 'streaming'
              );
          });
          if (actionable.length) scheduleEnhanceAll(actionable);
        });
        observer.observe(chatTimeline, {
          childList: true,
          subtree: true,
          attributes: true,
          attributeFilter: ['data-message-status'],
        });
      }
      enhanceAll();
      return dispose;
    }

    function dispose() {
      if (disposed) {
        return;
      }
      disposed = true;
      if (observer && typeof observer.disconnect === 'function') {
        observer.disconnect();
      }
      observer = null;
      if (scheduledHandle !== null && win) {
        if (scheduledWithAnimationFrame && typeof win.cancelAnimationFrame === 'function') {
          win.cancelAnimationFrame(scheduledHandle);
        } else if (!scheduledWithAnimationFrame && typeof win.clearTimeout === 'function') {
          win.clearTimeout(scheduledHandle);
        }
      }
      scheduledHandle = null;
      scheduled = false;
      pendingEnhanceRoots.clear();
      if (typeof detachClick === 'function') {
        detachClick();
        detachClick = null;
      }
    }

    return {
      attach: attach,
      dispose: dispose,
      enhanceAll: enhanceAll,
      enhanceBubble: enhanceBubble,
      openCitation: openCitation,
    };
  }

  // Self-installation: wire a default controller against the live DOM, the real
  // workspaceFs bridge, and the feature-flag state. No other module imports
  // this — it is fully decoupled. The observer/listener are only attached once
  // the flag is confirmed ON (read once at boot), so a disabled feature is inert.
  function installSelf(root) {
    var doc = root && root.document;
    if (!doc) {
      return null; // non-browser (test) context
    }
    var enabled = false;
    var attached = false;
    var controller = null;
    var controllerDispose = null;

    function getWorkspaceFs() {
      return (root.jennyShell && root.jennyShell.workspaceFs) || null;
    }
    function isEnabled() {
      return enabled === true;
    }

    function ensureAttached() {
      if (enabled && controller && !attached) {
        attached = true;
        controllerDispose = controller.attach();
      }
    }

    function applyFlagState(state) {
      enabled = Boolean(
        state && state.featureFlags && state.featureFlags.workspace_codebase_context === true
      );
      ensureAttached();
    }

    // Read the flag once at boot. We deliberately do NOT hold a
    // features.onChanged subscription: this module self-installs outside the
    // shell's cleanup registry, so a live subscription would leak across
    // renderer reloads (and inflate the lifecycle listener counts). Toggling
    // the flag applies on the next reload, which is an acceptable trade for
    // staying fully decoupled.
    function refreshFlag() {
      try {
        var features = root.jennyShell && root.jennyShell.features;
        if (features && typeof features.getState === 'function') {
          Promise.resolve(features.getState()).then(applyFlagState).catch(function noop() {});
        }
      } catch (_error) {
        // best-effort — feature gating just stays off
      }
    }

    function boot() {
      var chatTimeline = doc.getElementById('chatTimeline');
      if (!chatTimeline) {
        return;
      }
      controller = createCodebaseCiteController({
        document: doc,
        window: root,
        chatTimeline: chatTimeline,
        getWorkspaceFs: getWorkspaceFs,
        isEnabled: isEnabled,
      });
      // Attach is deferred to refreshFlag()->applyFlagState()->ensureAttached()
      // so the MutationObserver is only created when the feature is enabled.
      refreshFlag();
    }

    function dispose() {
      if (typeof controllerDispose === 'function') {
        controllerDispose();
        controllerDispose = null;
      } else if (controller && typeof controller.dispose === 'function') {
        controller.dispose();
      }
    }

    if (doc.readyState === 'loading') {
      doc.addEventListener('DOMContentLoaded', boot, { once: true });
    } else {
      boot();
    }
    return { boot: boot, dispose: dispose };
  }

  return {
    createCodebaseCiteController: createCodebaseCiteController,
    findCodebaseCitations: findCodebaseCitations,
    parseCodebaseCiteHref: parseCodebaseCiteHref,
    buildCodebaseCiteHref: buildCodebaseCiteHref,
    installSelf: installSelf,
  };
});
