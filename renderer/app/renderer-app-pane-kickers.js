/* renderer/app/renderer-app-pane-kickers.js -- the split view's pane kickers and focused-chat signal (UMD) */
/**
 * Extracted from renderer-app-pane-composition.js (which creates it once and
 * calls through).
 *   renderKickers()  hidden and empty with one pane (identity); with two, the
 *       session title, "· project" when the two panes' projects differ, and a
 *       close glyph. Rebuilt only when what it shows changed.
 *   resetKickers()  a mount or unmount clears the key: the new or restored
 *       kicker node starts empty.
 *   noteFocusedChat()  raises `jenny:focused-chat-changed` (window) when the
 *       focused chat, pane 0's chat or either one's project changed.
 *
 * deps: layoutController, call, doc, jt, kickerFor, paneSessionId,
 * insertButton, startKickerDrag, normalizeId, safely.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererAppPaneKickers = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var GENERAL_PROJECT_ID = 'project_general';
  var ICON_CLOSE = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>';

  function createPaneKickers(deps) {
    var layoutController = deps.layoutController;
    var call = deps.call;
    var doc = deps.doc;
    var jt = deps.jt;
    var kickerFor = deps.kickerFor;
    var paneSessionId = deps.paneSessionId;
    var insertButton = deps.insertButton;
    var startKickerDrag = deps.startKickerDrag;
    var normalizeId = deps.normalizeId;
    var safely = deps.safely;
    function projectKey(value) { return normalizeId(value) || GENERAL_PROJECT_ID; }

    function sessionTitle(sessionId) {
      var summary = call('getSessionSummary', sessionId);
      var title = summary && normalizeId(summary.title);
      return title || jt('chat.empty.newSession', 'New session');
    }
    /* Rebuilt only when what it shows changed, so the header/full-render sync
       can call it on every pass (a rename, an auto-title or a project move
       reaches the kicker without a layout change). */
    var kickerKey = '';
    function renderKickers() {
      var layout = layoutController.getLayout();
      var two = layout.panes.length > 1;
      var projects = layout.panes.map(function (entry) {
        var summary = call('getSessionSummary', entry.sessionId);
        return projectKey(summary && summary.project_id);
      });
      var projectsDiffer = two && projects[0] !== projects[1];
      var lines = [0, 1].map(function (paneId) {
        if (!two) return null;
        return {
          title: sessionTitle(paneSessionId(paneId)),
          projectName: projectsDiffer ? normalizeId(call('getProjectName', projects[paneId])) : '',
        };
      });
      var key = JSON.stringify(lines);
      if (key === kickerKey) return;
      kickerKey = key;
      [0, 1].forEach(function (paneId) {
        var kicker = kickerFor(paneId);
        if (!kicker) return;
        kicker.replaceChildren();
        kicker.hidden = !two;
        if (!two) return;
        var title = doc.createElement('span');
        title.className = 'chat-pane-kicker-title';
        title.setAttribute('dir', 'auto'); // an English title keeps LTR inside RTL chrome
        title.textContent = lines[paneId].title;
        title.addEventListener('pointerdown', function (event) { startKickerDrag(event, paneId); });
        kicker.appendChild(title);
        var projectName = lines[paneId].projectName;
        if (projectName) {
          var project = doc.createElement('span');
          project.className = 'chat-pane-kicker-project';
          project.textContent = ' ' + jt('chat.panes.kickerProject', '· {name}', { name: projectName });
          kicker.appendChild(project);
        }
        var label = jt('chat.panes.close', 'Close pane');
        var close = insertButton(kicker, { className: 'workspace-rail-close-button chat-pane-close', ariaLabel: label, title: label, trustedHtml: ICON_CLOSE });
        if (close) close.addEventListener('click', function () { layoutController.closePane(paneId); });
      });
    }

    /* The Explorer nudge names the focused chat's project (pane 0's while docked): a header or full
       render raises `jenny:focused-chat-changed` only when either chat or its project moved. */
    var focusedChatKey = '';
    function projectOfSession(sessionId) {
      var summary = sessionId ? call('getSessionSummary', sessionId) : null;
      return normalizeId(summary && summary.project_id);
    }
    function noteFocusedChat() {
      var layout = layoutController.getLayout();
      var focused = layout.panes[layout.focusedPaneId] ? layout.panes[layout.focusedPaneId].sessionId : '';
      var zero = layout.panes[0] ? layout.panes[0].sessionId : '';
      var key = [focused, projectOfSession(focused), zero, projectOfSession(zero)].join('\u0000');
      if (key === focusedChatKey) return;
      focusedChatKey = key;
      var view = doc && doc.defaultView;
      if (view && typeof view.CustomEvent === 'function') safely(function () { view.dispatchEvent(new view.CustomEvent('jenny:focused-chat-changed')); });
    }

    return {
      renderKickers: renderKickers,
      resetKickers: function () { kickerKey = ''; },
      noteFocusedChat: noteFocusedChat,
    };
  }

  return { createPaneKickers: createPaneKickers };
});
