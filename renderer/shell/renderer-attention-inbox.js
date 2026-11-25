/* renderer/shell/renderer-attention-inbox.js -- "Needs you" section + badge (UMD) */
/**
 * The pinned section at the top of the Chats panel, and the count badge beside
 * the titlebar health pill.
 *
 * It answers tool approvals in place: the approve/deny bridge takes the
 * approval id the backend minted for the call (the same reference the
 * transcript card passes; a bare call id is refused for runtime-decision
 * approvals) and carries no session, so a wait in a chat that is not open can
 * be answered from here without opening it. It never claims an outcome the bridge
 * has not returned -- a `false` result reads "Already resolved" and is logged,
 * a thrown error re-enables the row and surfaces once, and nothing reads as
 * approved before the bridge says true. Plans and question batches are never
 * answered from a one-line row: those buttons open the conversation.
 *
 * It is written in the Chats panel's own language (styles/attention-inbox.css,
 * and the A4 digest under it): the panel's `.group-label` kicker with the
 * answerable count as plain text inside it, plain hoverable rows, text
 * decisions, and a titlebar mark shaped like the health pill. Because a wait is
 * answered out of its conversation, the row's title is a BUTTON that opens that
 * conversation -- the one click back to the context.
 *
 * The titlebar badge's DOM lives in renderer-attention-inbox-flyout.js.
 * The conversation on screen keeps a one-line row and no decisions: its
 * transcript card is where it is answered. `getSnapshot()` is what the chat
 * dots read.
 *
 * It owns no clock. `render()` is called from the same passes that already
 * refresh the chats panel and the workspace chrome, so an approval arriving in
 * a background session reaches the inbox on the chrome frame that event
 * already queues -- there is no timer and no poll here. Those passes are every
 * streaming frame, so a pass first takes a cheap fingerprint of the sources and
 * returns without building a model when nothing they carry has moved.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./renderer-attention-inbox-model'));
    return;
  }
  root.rendererAttentionInbox = factory(root.rendererAttentionInboxModel);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (inboxModel) {
  'use strict';

  var jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };

  /* The section's DOM-id prefix, so no id repeats in the document. */
  var PANEL_PREFIX = 'attention-inbox-';
  var EMPTY_SNAPSHOT = Object.freeze({ answerable: 0, waitingSessionIds: Object.freeze([]), states: new Map(), key: '' });
  var COLLAPSED_STORAGE_KEY = 'jenny.attentionInbox.collapsed';
  var ROW_CLASS = 'attention-inbox__row';
  var ACTION_CLASS = 'attention-inbox__action';
  var TITLE_CLASS = 'attention-inbox__open';
  /* The kicker's own disclosure marks, as the Chats panel writes them. */
  var CHEVRON_OPEN = '▾';
  var CHEVRON_CLOSED = '▸';

  function slug(value) {
    return String(value || 'row').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'row';
  }

  function noopController() {
    return { render: function render() {}, dispose: function dispose() {}, getSnapshot: function getSnapshot() { return EMPTY_SNAPSHOT; } };
  }

  function flyoutModule() {
    if (globalThis.rendererAttentionInboxFlyout) return globalThis.rendererAttentionInboxFlyout;
    if (typeof require !== 'function') return null;
    try { return require('./renderer-attention-inbox-flyout'); } catch (_error) { return null; }
  }

  /**
   * @param {Object} [deps]
   * @param {Window} deps.windowRef
   * @param {Document} deps.documentRef
   * @param {Object} deps.state - Renderer state (sessions, pendingToolApprovals)
   * @param {HTMLElement} deps.host - #attentionInbox
   * @param {HTMLElement} [deps.badgeAnchor] - #workbenchHealthPillSlot
   * @param {Function} [deps.actionButton] - inventoryActionButton
   * @param {Object} [deps.facts] - { getApprovalFacts, getApprovalCommandPreview }
   * @param {Object} [deps.callbacks] - { openSession, setActiveView, appendClientLog, showComposerActionError }
   * @param {Function} [deps.getAttentionInbox] - Overrides the built-in model read
   * @param {Function} [deps.onInboxRows] - Told the model rows on every pass whose sources moved
   * @returns {{render, dispose, getSnapshot}}
   */
  function createAttentionInboxController(deps) {
    var options = deps && typeof deps === 'object' ? deps : {};
    var host = options.host;
    var documentRef = options.documentRef || (host && host.ownerDocument) || null;
    if (!host || !documentRef || typeof host.appendChild !== 'function') return noopController();

    var windowRef = options.windowRef || documentRef.defaultView || globalThis;
    var state = options.state && typeof options.state === 'object' ? options.state : {};
    var actionButton = typeof options.actionButton === 'function' ? options.actionButton : null;
    var callbacks = options.callbacks && typeof options.callbacks === 'object' ? options.callbacks : {};
    var appendClientLog = typeof callbacks.appendClientLog === 'function' ? callbacks.appendClientLog : null;
    // index.html loads it first (require is the Node path); a missing module leaves the section without its badge.
    var flyoutApi = flyoutModule();

    /* Where rows render: the panel's section, which owns the listeners of its own controls. */
    var panel = { host: host, prefix: PANEL_PREFIX, cleanup: [] };
    var snapshot = EMPTY_SNAPSHOT;
    var fingerprint = null;
    var signature = null;
    var collapsed = null;
    var disposed = false;
    var onTeam = function onTeam() { render(); }; // renderer-team-notify.js announces a change in what waits on this member
    /* Keys the bridge has answered (dropped at once; the resolved stream event
     * prunes the map) and keys it refused as no longer active. */
    var resolved = new Set();
    var stale = new Set();
    var staleShown = new Set();
    var inFlight = new Set();

    function log(level, event, data) { if (appendClientLog) appendClientLog(level, event, data); }

    function readCollapsed() {
      if (collapsed !== null) return collapsed;
      collapsed = false;
      try {
        collapsed = windowRef.localStorage.getItem(COLLAPSED_STORAGE_KEY) === 'true';
      } catch (_error) { /* private mode, blocked storage: the section opens */ }
      return collapsed;
    }

    function writeCollapsed(value) {
      collapsed = value === true;
      try {
        windowRef.localStorage.setItem(COLLAPSED_STORAGE_KEY, collapsed ? 'true' : 'false');
      } catch (_error) { /* remembering the choice is a convenience, not a contract */ }
    }

    /* A cheap read of the sources, taken before the model is built (the model's sourceFingerprint). */
    function sourceFingerprint() {
      return model().sourceFingerprint(state, { collapsed: readCollapsed(), stuckSends: stuckSends(),
        questionCards: questionCards(), verdicts: [stale, inFlight, resolved] });
    }

    function readInbox() {
      if (typeof options.getAttentionInbox === 'function') return options.getAttentionInbox();
      var build = (inboxModel && inboxModel.buildAttentionInbox)
        || (globalThis.rendererAttentionInboxModel && globalThis.rendererAttentionInboxModel.buildAttentionInbox);
      if (typeof build !== 'function') return { rows: [], counts: { answerable: 0 }, hidden: true };
      return build({
        sessions: state.sessions,
        pendingToolApprovals: state.pendingToolApprovals,
        currentSessionId: state.currentSessionId,
        currentSessionOnScreen: !!(state.ui && state.ui.activeView === 'chat'),
        facts: options.facts,
        stuckSends: stuckSends(), questionCards: questionCards(),
      });
    }

    function element(tag, className, content) {
      var node = documentRef.createElement(tag);
      if (className) node.className = className;
      if (content !== undefined) node.textContent = content;
      return node;
    }

    function control(parent, spec) {
      if (!actionButton) return null;
      var wrapper = documentRef.createElement('span');
      wrapper.innerHTML = actionButton({
        domId: spec.domId,
        plain: true,
        className: spec.className,
        label: spec.label,
        title: spec.title,
        ariaLabel: spec.ariaLabel,
        disabled: spec.disabled === true,
        dataset: { 'attention-action': spec.action },
      });
      var node = wrapper.firstElementChild;
      if (!node) return null;
      if (spec.modifier) node.classList.add(spec.modifier);
      node.addEventListener('click', spec.onClick);
      panel.cleanup.push(function detach() { node.removeEventListener('click', spec.onClick); });
      parent.appendChild(node);
      return node;
    }

    function setRowBusy(key, busy) {
      // Compared, never interpolated into a selector: a call id carrying a quote
      // or a bracket must not throw inside the click that owns it.
      host.querySelectorAll('.' + ROW_CLASS).forEach(function eachRow(row) {
        if (row.dataset.attentionKey !== key) return;
        // The decisions go dead; the row keeps its surface, because a row that
        // dims while the bridge answers reads as an outcome it has not had.
        // Disabling the pressed decision would blur it: focus the title first.
        var active = documentRef.activeElement;
        if (busy === true && active && row.contains(active) && active.classList.contains(ACTION_CLASS)) {
          var title = row.querySelector('.' + TITLE_CLASS);
          if (title && typeof title.focus === 'function') title.focus();
        }
        row.querySelectorAll('.' + ACTION_CLASS).forEach(function disable(node) {
          node.disabled = busy === true;
        });
      });
    }

    /* Both gates, because a redraw follows a verdict this controller holds
     * locally (resolved / stale), which no source fingerprint can see. */
    function redraw() {
      fingerprint = null;
      signature = null;
      render();
    }

    function answerApproval(row, decision) {
      if (inFlight.has(row.key) || resolved.has(row.key) || stale.has(row.key)) return;
      var tools = windowRef.jennyShell && windowRef.jennyShell.tools;
      var call = decision === 'deny' ? tools && tools.deny : tools && tools.approve;
      if (typeof call !== 'function') return;
      inFlight.add(row.key);
      setRowBusy(row.key, true);
      // The approval id, not the call id: the backend keys its pending map by the scoped approval id, and a
      // bare call id would read "Already resolved" while the turn is still blocked.
      var request = decision === 'deny'
        ? tools.deny(row.approvalId)
        : tools.approve(row.approvalId, { alwaysAllow: decision === 'always' });
      var failureTitle = decision === 'deny'
        ? jt('chat.attentionInbox.denyFailedTitle', 'Deny Failed')
        : jt('chat.attentionInbox.approvalFailedTitle', 'Approval Failed');
      function surface(error) {
        if (typeof callbacks.showComposerActionError === 'function') callbacks.showComposerActionError(error, failureTitle);
      }
      Promise.resolve(request).then(function settle(result) {
        inFlight.delete(row.key);
        if (disposed) return;
        if (result === false) {
          // The approval reference is no longer pending: the row says so
          // rather than implying the decision landed, and the same notice the
          // transcript's card raises for this case is raised here, because the
          // stale row leaves on the next pass and could go unseen.
          stale.add(row.key);
          log('WARN', 'chat.attention_inbox_stale', { decision: decision, callId: row.callId, approvalId: row.approvalId });
          surface(new Error(jt('chat.attentionInbox.alreadyResolvedDetail',
            'This approval request was already resolved or is no longer active.')));
        } else {
          resolved.add(row.key);
        }
        redraw();
      }).catch(function failed(error) {
        inFlight.delete(row.key);
        if (disposed) return;
        log('ERROR', 'chat.attention_inbox_failed', {
          decision: decision, callId: row.callId, approvalId: row.approvalId,
          message: String(error && error.message ? error.message : error || ''),
        });
        surface(error);
        redraw();
      });
    }

    function openSession(sessionId, row) {
      if (row && row.source === 'team') model().openTeamConversation(row);
      else if (typeof callbacks.openSession === 'function') callbacks.openSession(sessionId);
    }

    /* One muted line under the title, ellipsised, with the whole of it kept
     * in the tooltip: the row is read out of the transcript's context, so it
     * may shorten what it shows but never drop it. */
    function muted(className, content) {
      var node = element('div', className, content);
      node.title = content;
      return node;
    }

    function model() { return inboxModel || globalThis.rendererAttentionInboxModel; }

    // Line 2 of an approval: the tool, then exactly what it was called with.
    // Line 3: what this call may do (renderer-attention-inbox-model.js policyLine).
    function renderApprovalRow(row, node) {
      var detail = element('div', 'attention-inbox__detail');
      detail.appendChild(element('span', 'attention-inbox__tool', row.toolName));
      if (row.preview) {
        detail.appendChild(documentRef.createTextNode(' '));
        detail.appendChild(element('code', 'attention-inbox__preview', row.preview));
      }
      detail.title = row.preview || row.toolName;
      node.appendChild(detail);
      node.appendChild(muted('attention-inbox__policy', model().policyLine(row)));
    }

    // Restart engine frees a model whose last reply's cleanup is unconfirmed;
    // the row leaves once the waiting message starts, never on this say-so.
    function restartEngine(row) {
      var controller = state.runtimeSendController;
      if (inFlight.has(row.key) || !controller || typeof controller.restartEngine !== 'function') return;
      inFlight.add(row.key);
      redraw();
      Promise.resolve(controller.restartEngine(row.sessionId)).catch(function failed(error) {
        log('ERROR', 'chat.attention_inbox_restart_failed', { message: String(error && error.message ? error.message : error || '') });
      }).then(function settle() { inFlight.delete(row.key); if (!disposed) redraw(); });
    }

    function stuckSends() {
      var controller = state.runtimeSendController;
      return controller && typeof controller.listStuckSends === 'function' ? controller.listStuckSends() : [];
    }

    function questionCards() {
      var cards = typeof options.getPendingQuestionCards === 'function' ? options.getPendingQuestionCards() : null;
      return Array.isArray(cards) ? cards : [];
    }

    /* Line 1: the conversation, and the row's way back to the context it is
     * being answered out of -- a button, never inert text. */
    function renderTitle(row, node) {
      var button = control(node, {
        action: 'open-session',
        domId: panel.prefix + 'session-' + slug(row.key),
        className: TITLE_CLASS,
        label: row.sessionTitle,
        title: jt('chat.attentionInbox.openSessionTitle', 'Open this conversation'),
        onClick: function onOpenSession() { openSession(row.sessionId, row); },
      });
      if (!button) return;
      var dot = element('span', 'attention-inbox__dot');
      dot.setAttribute('aria-hidden', 'true');
      // A chat the model could not name says so quietly; the same catalog key
      // it named it with is the only way to tell.
      var untitled = row.sessionTitle === jt('chat.attentionInbox.untitledSession', 'Untitled chat');
      var label = element('span', 'attention-inbox__session' + (untitled ? ' attention-inbox__session--untitled' : ''),
        row.sessionTitle);
      // The title is a single line that ellipsises beside a dot that does not.
      button.replaceChildren(dot, label);
    }

    // One text decision: its DOM id and modifier class follow the action's name.
    function decide(actions, row, spec) {
      control(actions, Object.assign({ domId: panel.prefix + (spec.idName || spec.action) + '-' + slug(row.key),
        className: ACTION_CLASS, modifier: ACTION_CLASS + '--' + spec.action }, spec));
    }

    function renderRowActions(row, node) {
      var actions = element('div', 'attention-inbox__actions');
      node.appendChild(actions);
      if (stale.has(row.key)) {
        actions.appendChild(element('span', 'attention-inbox__stale',
          jt('chat.attentionInbox.alreadyResolved', 'Already resolved')));
        return;
      }
      var busy = inFlight.has(row.key);
      function onOpen() { openSession(row.sessionId, row); }
      if (row.kind === 'approval' && row.source !== 'team') {
        if (row.canAllow !== false) {
          decide(actions, row, {
            action: 'allow', label: jt('chat.attentionInbox.allow', 'Allow'), disabled: busy,
            title: jt('chat.attentionInbox.allowTitle', 'Allow this one call'),
            onClick: function onAllow() { answerApproval(row, 'once'); },
          });
        }
        if (row.canAllow !== false && row.canAlwaysAllow) {
          decide(actions, row, {
            action: 'always', label: jt('chat.attentionInbox.alwaysAllow', 'Always allow'), disabled: busy,
            title: jt('chat.attentionInbox.alwaysAllowTitle', 'Allow this call and stop asking for {tool}', { tool: row.toolName }),
            onClick: function onAlways() { answerApproval(row, 'always'); },
          });
        }
        decide(actions, row, {
          action: 'deny', label: jt('chat.attentionInbox.deny', 'Deny'), disabled: busy,
          title: jt('chat.attentionInbox.denyTitle', 'Refuse this call'),
          onClick: function onDeny() { answerApproval(row, 'deny'); },
        });
        return;
      }
      if (row.kind === 'stuck_send') {
        decide(actions, row, { action: 'open', label: jt('chat.attentionInbox.open', 'Open'), onClick: onOpen });
        decide(actions, row, {
          action: 'restart', label: jt('chat.stuckSend.restartEngine', 'Restart engine'), disabled: busy,
          title: jt('chat.runtimeQueue.restartTitle', 'Restart the engine so this message can start'),
          onClick: function onRestart() { restartEngine(row); },
        });
        return;
      }
      // A plan is read in its conversation, a question batch is answered in the
      // transcript that holds it, and a failed send is retried or cancelled in
      // the chat that sent it: every one of these buttons opens the chat.
      var isQuestion = row.kind === 'question';
      decide(actions, row, {
        action: isQuestion ? 'answer' : 'open', idName: 'open',
        label: isQuestion ? jt('chat.attentionInbox.answer', 'Answer') : jt('chat.attentionInbox.open', 'Open'),
        title: row.source === 'team' ? jt('team.home.openTitle', 'Open this conversation in Team')
          : isQuestion ? jt('chat.attentionInbox.answerTitle', 'Open this chat to answer')
          : row.kind === 'delivery_failed' ? jt('chat.attentionInbox.deliveryFailedTitle', 'Open this chat to retry or cancel the send')
            : jt('chat.attentionInbox.openTitle', 'Open this chat to read the plan'),
        onClick: onOpen,
      });
    }

    function renderRow(row, list) {
      var node = element('div', ROW_CLASS);
      node.classList.add(ROW_CLASS + '--' + row.kind);
      node.dataset.attentionKey = row.key;
      if (row.source === 'team') { node.classList.add(ROW_CLASS + '--team'); node.dir = 'auto'; } // names read in their own direction
      renderTitle(row, node);
      if (row.onScreen) {
        // Its own transcript card is where this wait is answered.
        node.classList.add(ROW_CLASS + '--here');
        node.appendChild(muted('attention-inbox__note', jt('chat.attentionInbox.onScreen', 'Waiting in the chat on screen')));
      } else {
        if (row.kind === 'approval' && row.source !== 'team') renderApprovalRow(row, node);
        else node.appendChild(muted('attention-inbox__note', model().rowNote(row)));
        renderRowActions(row, node);
      }
      list.appendChild(node);
    }

    /* The panel's own kicker, reused class and all (.group-label in
     * styles/chats-panel.css): the count is plain text inside it, never a
     * pill, and the whole kicker is the collapse toggle. */
    function renderHeading(answerable) {
      var heading = element('div', 'attention-inbox__heading');
      var toggle = control(heading, {
        action: 'toggle', domId: panel.prefix + 'toggle', className: 'group-label attention-inbox__toggle',
        label: jt('chat.attentionInbox.title', 'Needs you'),
        title: jt('chat.attentionInbox.toggleTitle', 'Show or hide what needs you'),
        onClick: function onToggle() { writeCollapsed(!readCollapsed()); redraw(); },
      });
      if (toggle) {
        toggle.setAttribute('aria-expanded', String(!readCollapsed()));
        toggle.setAttribute('aria-controls', panel.prefix + 'list');
        toggle.appendChild(element('span', 'attention-inbox__count', String(answerable)));
        var chevron = element('span', 'attention-inbox__chevron', readCollapsed() ? CHEVRON_CLOSED : CHEVRON_OPEN);
        chevron.setAttribute('aria-hidden', 'true');
        toggle.appendChild(chevron);
      }
      return heading;
    }

    /* The section's whole content, rebuilt from the rows of this pass. */
    function paint(rows, answerable) {
      var active = documentRef.activeElement;
      var focusedId = active && host.contains(active) ? active.id : '';
      while (panel.cleanup.length) panel.cleanup.pop()();
      host.replaceChildren();
      host.hidden = rows.length === 0;
      if (!rows.length) return;
      host.appendChild(renderHeading(answerable));
      var list = element('div', 'attention-inbox__list');
      list.id = panel.prefix + 'list';
      list.hidden = readCollapsed();
      list.setAttribute('role', 'group');
      list.setAttribute('aria-label', jt('chat.attentionInbox.listLabel', 'Everything waiting on you'));
      host.appendChild(list);
      rows.forEach(function addRow(row) {
        renderRow(row, list);
        if (stale.has(row.key)) staleShown.add(row.key);
      });
      var restore = focusedId ? documentRef.getElementById(focusedId) : null;
      // A focused row that just left (answered) hands focus to the first title, never to the body.
      if (focusedId && !(restore && host.contains(restore))) restore = host.querySelector('.' + TITLE_CLASS);
      if (restore && host.contains(restore) && !restore.disabled) restore.focus();
    }

    function handleBadgeClick() {
      // The section lives in the Chats panel: chat view first.
      if (typeof callbacks.setActiveView === 'function') callbacks.setActiveView('chat');
      render(); // the view just changed, so which chat is "on screen" may have too
      if (readCollapsed()) { writeCollapsed(false); redraw(); }
      if (typeof host.scrollIntoView === 'function') host.scrollIntoView({ block: 'start' });
      // The title, never a decision: a stray Space or Enter must not approve a call.
      var first = host.querySelector('.' + TITLE_CLASS);
      if (first && typeof first.focus === 'function') first.focus();
    }

    if (typeof windowRef.addEventListener === 'function') windowRef.addEventListener('jenny:team-attention', onTeam);
    var badge = flyoutApi && typeof flyoutApi.createAttentionInboxBadge === 'function' && actionButton
      ? flyoutApi.createAttentionInboxBadge({ anchor: options.badgeAnchor, actionButton: actionButton, onClick: handleBadgeClick })
      : null;

    function render() {
      if (disposed) return;
      // A badge something else tore out of the titlebar is rebuilt on this pass.
      if (badge && badge.tornOut()) { fingerprint = null; signature = null; }
      // "Already resolved" is shown once; the next pass drops that row, because
      // the wait it stood for is not pending any more. Retired BEFORE the
      // fingerprint is taken, so that pass sees a moved source and rebuilds.
      staleShown.forEach(function retireStale(key) {
        staleShown.delete(key);
        stale.delete(key);
        resolved.add(key);
      });
      // Nothing the rows are made of has moved: no model build, no serialized
      // signature, no DOM walk. This is the pass that runs on every frame.
      var nextFingerprint = sourceFingerprint();
      if (fingerprint === nextFingerprint) return;
      fingerprint = nextFingerprint;
      var inbox = readInbox();
      var modelRows = Array.isArray(inbox && inbox.rows) ? inbox.rows : [];
      // Desktop notifications see every moved pass; a failure never breaks the inbox.
      try { if (typeof options.onInboxRows === 'function') options.onInboxRows(modelRows.filter(function local(row) { return row.source !== 'team'; })); } catch (_error) { /* optional */ }
      var live = new Set(modelRows.map(function keyOf(row) { return row.key; }));
      // A wait the sources no longer list is gone for good; forget its verdict.
      resolved.forEach(function pruneResolved(key) { if (!live.has(key)) resolved.delete(key); });
      stale.forEach(function pruneStale(key) { if (!live.has(key)) stale.delete(key); });
      var rows = modelRows.filter(function isVisible(row) { return !resolved.has(row.key); });
      var answerable = rows.filter(function isAnswerable(row) { return !stale.has(row.key); });
      snapshot = model().snapshotOf(answerable);
      // The second gate: what the rows would actually say, so a source that
      // moved without changing a word still touches no DOM.
      var next = JSON.stringify([readCollapsed(), answerable.length, rows.map(function rowContent(row) {
        return model().rowSignature(row).concat([stale.has(row.key), inFlight.has(row.key)]);
      })]);
      if (signature === next) return;
      signature = next;
      if (badge) badge.sync(answerable.length);
      paint(rows, answerable.length);
    }

    function dispose() {
      if (disposed) return;
      disposed = true;
      if (typeof windowRef.removeEventListener === 'function') windowRef.removeEventListener('jenny:team-attention', onTeam);
      while (panel.cleanup.length) panel.cleanup.pop()();
      if (badge) badge.dispose();
      host.replaceChildren();
      host.hidden = true;
    }

    return { render: render, dispose: dispose, getSnapshot: function getSnapshot() { return snapshot; } };
  }

  return { createAttentionInboxController: createAttentionInboxController };
});
