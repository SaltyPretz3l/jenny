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
  var jtn = (globalThis.jennyI18n && globalThis.jennyI18n.tn) || function (k, count, params, one, other) { return jt.call(null, k, count === 1 ? one : other, params); };

  var BADGE_ID = 'attentionInboxBadge';
  var LIST_ID = 'attention-inbox-list';
  var TOGGLE_ID = 'attention-inbox-toggle';
  var COLLAPSED_STORAGE_KEY = 'jenny.attentionInbox.collapsed';
  var ROW_CLASS = 'attention-inbox__row';
  var ACTION_CLASS = 'attention-inbox__action';
  var TITLE_CLASS = 'attention-inbox__open';
  /* One muted line, joined the way the Chats panel joins facts. */
  var LINE_SEPARATOR = ' · ';
  /* The kicker's own disclosure marks, as the Chats panel writes them. */
  var CHEVRON_OPEN = '▾';
  var CHEVRON_CLOSED = '▸';
  /* Field separators for the source fingerprint: never valid in an id, a
   * title or a batch id, so two different sets of sources cannot collide. */
  var FIELD = '\u0001';
  var PART = '\u0002';
  var GROUP = '\u0003';

  function sortedKeys(set) {
    return [...set].sort().join(FIELD);
  }

  function resolveBackendStrings() {
    if (globalThis.jennyBackendStrings) return globalThis.jennyBackendStrings;
    if (typeof require === 'function') {
      try { return require('../shared/i18n-backend-strings'); } catch (_error) { /* not available */ }
    }
    return null;
  }

  // Scope and consequence are backend strings: translate them exactly as the
  // transcript card does (renderer-approval-block.js), else show the text.
  function translatePolicyText(method, value) {
    var strings = resolveBackendStrings();
    if (!strings || typeof strings[method] !== 'function') return value;
    try { return strings[method](value); } catch (_error) { return value; }
  }

  function slug(value) {
    return String(value || 'row').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'row';
  }

  function noopController() {
    return { render: function render() {}, dispose: function dispose() {} };
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
   * @param {Object} [deps.callbacks] - { openSession, setActiveView, setSidebarCollapsed, appendClientLog, showComposerActionError }
   * @param {Function} [deps.getAttentionInbox] - Overrides the built-in model read
   * @returns {{render: Function, dispose: Function}}
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

    var cleanup = [];
    var badge = null;
    var badgeCleanup = null;
    var fingerprint = null;
    var signature = null;
    var collapsed = null;
    var disposed = false;
    /* Keys the bridge has answered (dropped at once; the resolved stream event
     * prunes the map) and keys it refused as no longer active. */
    var resolved = new Set();
    var stale = new Set();
    var staleShown = new Set();
    var inFlight = new Set();

    function log(level, event, data) {
      if (appendClientLog) appendClientLog(level, event, data);
    }

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

    /* A cheap read of the sources THEMSELVES, taken before the model is built.
     * render() runs on every workspace-chrome pass, which during streaming is
     * every frame, and a model build is two source scans, a facts-helper call
     * per approval, a sort and a signature serialization. The approval map's
     * keys, each summary's id, title and pending batch, the conversation on
     * screen, the collapsed choice and this controller's own local verdicts
     * are everything a rendered row can be made of, so an unchanged
     * fingerprint means an unchanged inbox. */
    function sourceFingerprint() {
      var approvals = state.pendingToolApprovals;
      var entries = [];
      if (approvals && typeof approvals.values === 'function') entries = [...approvals.values()];
      else if (Array.isArray(approvals)) entries = approvals;
      // The key AND the fields a row is made of: rehydration re-sets the same
      // key synchronously with the persisted fields, so no pass sees the key
      // move (the input never changes under one call id).
      var approvalKeys = entries.map(function sourceOf(entry) {
        if (!entry || typeof entry !== 'object') return '';
        return [entry.approvalId || entry.callId || '', entry.sessionId || '', entry.toolName || '',
          entry.policyScope || '', entry.policyConsequence || '', entry.reason || '', entry.summary || '',
          entry.oneOffOnly === true ? '1' : '0'].join(PART);
      }).join(FIELD);
      var sessions = Array.isArray(state.sessions) ? state.sessions : [];
      var sessionKeys = sessions.map(function sourceOf(summary) {
        if (!summary || typeof summary !== 'object') return '';
        var batch = summary.pending_question_batch;
        var questions = batch && Array.isArray(batch.questions) ? batch.questions.length : 0;
        // The title is in here because a conversation renamed mid-wait must
        // rename its row, and nothing else in these sources would say so.
        // The intro, clipped as the model clips it: revised under one batch id.
        return String(summary.id || '') + PART + String(summary.title || '')
          + PART + String((batch && batch.batch_id) || '') + PART + questions
          + PART + String((batch && batch.intro_text) || '').slice(0, 120);
      }).join(FIELD);
      return [
        readCollapsed() ? '1' : '0', String(state.currentSessionId || ''), approvalKeys, sessionKeys,
        sortedKeys(stale), sortedKeys(inFlight), sortedKeys(resolved),
      ].join(GROUP);
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
        facts: options.facts,
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
      cleanup.push(function detach() { node.removeEventListener('click', spec.onClick); });
      parent.appendChild(node);
      return node;
    }

    function findRow(key) {
      // Compared, never interpolated into a selector: a call id carrying a
      // quote or a bracket must not throw inside the click that owns it.
      var rows = host.querySelectorAll('.' + ROW_CLASS);
      for (var index = 0; index < rows.length; index += 1) {
        if (rows[index].dataset.attentionKey === key) return rows[index];
      }
      return null;
    }

    function setRowBusy(key, busy) {
      var row = findRow(key);
      if (!row) return;
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
      // The approval id, not the call id: the backend keys its pending map by
      // the scoped approval id and only falls back to a call-id scan when the
      // approval does not require an exact reference (runtime-decision
      // approvals do), so a bare call id would read "Already resolved" while
      // the turn is still blocked.
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

    function openSession(sessionId) {
      if (typeof callbacks.openSession === 'function') callbacks.openSession(sessionId);
    }

    /* One muted line under the title, ellipsised, with the whole of it kept
     * in the tooltip: the row is read out of the transcript's context, so it
     * may shorten what it shows but never drop it. */
    function muted(className, content) {
      var node = element('div', className, content);
      node.title = content;
      return node;
    }

    // Line 2 of an approval: the tool, then exactly what it was called with.
    function renderApprovalDetail(row, node) {
      var detail = element('div', 'attention-inbox__detail');
      detail.appendChild(element('span', 'attention-inbox__tool', row.toolName));
      if (row.preview) {
        detail.appendChild(documentRef.createTextNode(' '));
        detail.appendChild(element('code', 'attention-inbox__preview', row.preview));
      }
      detail.title = row.preview || row.toolName;
      node.appendChild(detail);
    }

    /* Line 3: what this call may do, in ONE uniform line -- the backend's
     * scope and consequence in its own words, then the writes-or-not facts,
     * none of them painted more alarming than another (the transcript card
     * keeps them uniform on purpose) -- or the card's own fallback line (the
     * same catalog key the backend-strings table resolves it to) when nothing
     * was declared at all, as for every MCP or plugin tool: the row never goes
     * silent on it. */
    function policyLine(row) {
      var parts = [];
      if (row.policyScope) parts.push(translatePolicyText('approvalScope', row.policyScope));
      if (row.consequence) parts.push(translatePolicyText('approvalConsequence', row.consequence));
      (Array.isArray(row.facts) ? row.facts : []).forEach(function addFact(fact) {
        if (fact && fact.label) parts.push(fact.label);
      });
      if (!parts.length) return jt('approval.consequence.reviewRequestedInput', 'Review requested input');
      return parts.join(LINE_SEPARATOR);
    }

    function renderApprovalRow(row, node) {
      renderApprovalDetail(row, node);
      node.appendChild(muted('attention-inbox__policy', policyLine(row)));
    }

    /* Line 1: the conversation, and the row's way back to the context it is
     * being answered out of -- a button, never inert text. */
    function renderTitle(row, node) {
      var button = control(node, {
        action: 'open-session',
        domId: 'attention-inbox-session-' + slug(row.key),
        className: TITLE_CLASS,
        label: row.sessionTitle,
        title: jt('chat.attentionInbox.openSessionTitle', 'Open this conversation'),
        onClick: function onOpenSession() { openSession(row.sessionId); },
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

    function renderRowActions(row, node) {
      var actions = element('div', 'attention-inbox__actions');
      node.appendChild(actions);
      if (stale.has(row.key)) {
        actions.appendChild(element('span', 'attention-inbox__stale',
          jt('chat.attentionInbox.alreadyResolved', 'Already resolved')));
        return;
      }
      var id = slug(row.key);
      var busy = inFlight.has(row.key);
      if (row.kind === 'approval') {
        control(actions, {
          action: 'allow', domId: 'attention-inbox-allow-' + id, className: ACTION_CLASS, modifier: 'attention-inbox__action--allow',
          label: jt('chat.attentionInbox.allow', 'Allow'), disabled: busy,
          title: jt('chat.attentionInbox.allowTitle', 'Allow this one call'),
          onClick: function onAllow() { answerApproval(row, 'once'); },
        });
        if (row.canAlwaysAllow) {
          control(actions, {
            action: 'always', domId: 'attention-inbox-always-' + id, className: ACTION_CLASS, modifier: 'attention-inbox__action--always',
            label: jt('chat.attentionInbox.alwaysAllow', 'Always allow'), disabled: busy,
            title: jt('chat.attentionInbox.alwaysAllowTitle', 'Allow this call and stop asking for {tool}', { tool: row.toolName }),
            onClick: function onAlways() { answerApproval(row, 'always'); },
          });
        }
        control(actions, {
          action: 'deny', domId: 'attention-inbox-deny-' + id, className: ACTION_CLASS, modifier: 'attention-inbox__action--deny',
          label: jt('chat.attentionInbox.deny', 'Deny'), disabled: busy,
          title: jt('chat.attentionInbox.denyTitle', 'Refuse this call'),
          onClick: function onDeny() { answerApproval(row, 'deny'); },
        });
        return;
      }
      // A plan is read in its conversation, and a question batch is answered in
      // the transcript that holds it: both buttons open the chat.
      var isPlan = row.kind === 'plan_review';
      control(actions, {
        action: isPlan ? 'open' : 'answer',
        domId: 'attention-inbox-open-' + id,
        className: ACTION_CLASS, modifier: isPlan ? 'attention-inbox__action--open' : 'attention-inbox__action--answer',
        label: isPlan ? jt('chat.attentionInbox.open', 'Open') : jt('chat.attentionInbox.answer', 'Answer'),
        title: isPlan
          ? jt('chat.attentionInbox.openTitle', 'Open this chat to read the plan')
          : jt('chat.attentionInbox.answerTitle', 'Open this chat to answer'),
        onClick: function onOpen() { openSession(row.sessionId); },
      });
    }

    function renderRow(row, list) {
      var node = element('div', ROW_CLASS);
      node.classList.add(ROW_CLASS + '--' + row.kind);
      node.dataset.attentionKey = row.key;
      renderTitle(row, node);
      if (row.kind === 'approval') {
        renderApprovalRow(row, node);
      } else if (row.kind === 'plan_review') {
        node.appendChild(muted('attention-inbox__note',
          jt('chat.attentionInbox.planReady', 'Plan ready for review')));
      } else {
        var waiting = jtn('chat.attentionInbox.questionsWaiting', row.questionCount, { count: String(row.questionCount) },
          '{count} question waiting', '{count} questions waiting');
        node.appendChild(muted('attention-inbox__note',
          row.introText ? waiting + LINE_SEPARATOR + row.introText : waiting));
      }
      renderRowActions(row, node);
      list.appendChild(node);
    }

    /* The panel's own kicker, reused class and all (.group-label in
     * styles/chats-panel.css): the count is plain text inside it, never a
     * pill, and the whole kicker is the collapse toggle. */
    function renderHeading(answerable) {
      var heading = element('div', 'attention-inbox__heading');
      var toggle = control(heading, {
        action: 'toggle', domId: TOGGLE_ID, className: 'group-label attention-inbox__toggle',
        label: jt('chat.attentionInbox.title', 'Needs you'),
        title: jt('chat.attentionInbox.toggleTitle', 'Show or hide what needs you'),
        onClick: function onToggle() { writeCollapsed(!readCollapsed()); redraw(); },
      });
      if (toggle) {
        toggle.setAttribute('aria-expanded', String(!readCollapsed()));
        toggle.setAttribute('aria-controls', LIST_ID);
        toggle.appendChild(element('span', 'attention-inbox__count', String(answerable)));
        var chevron = element('span', 'attention-inbox__chevron', readCollapsed() ? CHEVRON_CLOSED : CHEVRON_OPEN);
        chevron.setAttribute('aria-hidden', 'true');
        toggle.appendChild(chevron);
      }
      return heading;
    }

    function ensureBadge() {
      if (badge || !actionButton) return badge;
      var anchor = options.badgeAnchor;
      if (!anchor || typeof anchor.insertAdjacentHTML !== 'function' || !anchor.parentNode) return null;
      // The health pill rewrites its slot's innerHTML on every status change,
      // so the badge lives beside the slot, never inside it.
      anchor.insertAdjacentHTML('afterend', actionButton({
        domId: BADGE_ID, plain: true, className: 'attention-inbox-badge',
        title: jt('chat.attentionInbox.badgeTitle', 'Open what needs you'),
        dataset: { 'i18n-title': 'chat.attentionInbox.badgeTitle' },
        // The health pill's shape, not its class: a dot and a number.
        trustedHtml: '<span class="attention-inbox-badge__dot" aria-hidden="true"></span>'
          + '<span class="attention-inbox-badge__count"></span>',
      }));
      badge = anchor.parentNode.querySelector('#' + BADGE_ID);
      if (!badge) return null;
      badge.addEventListener('click', handleBadgeClick);
      badgeCleanup = function detachBadge() { badge.removeEventListener('click', handleBadgeClick); };
      return badge;
    }

    function handleBadgeClick() {
      // The badge is visible from every view, but the section lives in the
      // Chats panel: switch to the chat view first, or un-collapsing would act
      // on whichever view's panel is active and focus a control off screen.
      if (typeof callbacks.setActiveView === 'function') callbacks.setActiveView('chat');
      if (typeof callbacks.setSidebarCollapsed === 'function') callbacks.setSidebarCollapsed(false);
      if (readCollapsed()) { writeCollapsed(false); redraw(); }
      if (typeof host.scrollIntoView === 'function') host.scrollIntoView({ block: 'start' });
      var first = host.querySelector('.' + ACTION_CLASS + ':not([disabled])');
      if (first && typeof first.focus === 'function') first.focus();
    }

    function syncBadge(answerable) {
      if (!answerable && !badge) return;
      if (!ensureBadge()) return;
      var count = badge.querySelector('.attention-inbox-badge__count');
      if (count) count.textContent = answerable > 0 ? String(answerable) : '';
      badge.hidden = answerable === 0;
      badge.setAttribute('aria-label', jtn('chat.attentionInbox.badgeLabel', answerable,
        { count: String(answerable) }, '{count} thing needs you', '{count} things need you'));
    }

    function render() {
      if (disposed) return;
      // A badge something else tore out of the titlebar is rebuilt on this
      // pass, not on the next content change.
      if (badge && !badge.isConnected) {
        if (badgeCleanup) badgeCleanup();
        badge = null;
        badgeCleanup = null;
        fingerprint = null;
        signature = null;
      }
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
      var live = new Set(modelRows.map(function keyOf(row) { return row.key; }));
      // A wait the sources no longer list is gone for good; forget its verdict.
      resolved.forEach(function pruneResolved(key) { if (!live.has(key)) resolved.delete(key); });
      stale.forEach(function pruneStale(key) { if (!live.has(key)) stale.delete(key); });
      var rows = modelRows.filter(function isVisible(row) { return !resolved.has(row.key); });
      var answerable = rows.filter(function isAnswerable(row) { return !stale.has(row.key); }).length;
      // The second gate: what the rows would actually say, so a source that
      // moved without changing a word still touches no DOM.
      var next = JSON.stringify([readCollapsed(), answerable, rows.map(function rowContent(row) {
        return [row.key, row.sessionTitle, row.toolName, row.preview, row.canAlwaysAllow, row.questionCount,
          row.introText, row.consequence, row.policyScope,
          (row.facts || []).map(function labelOf(fact) { return fact.label; }),
          stale.has(row.key), inFlight.has(row.key)];
      })]);
      if (signature === next) return;
      signature = next;
      var active = documentRef.activeElement;
      var focusedId = active && host.contains(active) ? active.id : '';
      while (cleanup.length) cleanup.pop()();
      host.replaceChildren();
      host.hidden = rows.length === 0;
      syncBadge(answerable);
      if (!rows.length) return;
      host.appendChild(renderHeading(answerable));
      var list = element('div', 'attention-inbox__list');
      list.id = LIST_ID;
      list.hidden = readCollapsed();
      list.setAttribute('role', 'group');
      list.setAttribute('aria-label', jt('chat.attentionInbox.listLabel', 'Everything waiting on you'));
      host.appendChild(list);
      rows.forEach(function addRow(row) {
        renderRow(row, list);
        if (stale.has(row.key)) staleShown.add(row.key);
      });
      var restore = focusedId ? documentRef.getElementById(focusedId) : null;
      if (restore && host.contains(restore) && !restore.disabled) restore.focus();
    }

    function dispose() {
      if (disposed) return;
      disposed = true;
      while (cleanup.length) cleanup.pop()();
      if (badgeCleanup) badgeCleanup();
      badgeCleanup = null;
      if (badge && typeof badge.remove === 'function') badge.remove();
      badge = null;
      host.replaceChildren();
      host.hidden = true;
    }

    return { render: render, dispose: dispose };
  }

  return { createAttentionInboxController: createAttentionInboxController };
});
