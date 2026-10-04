/* renderer/chat/renderer-admission-wait-line.js -- the timeline line for a send held behind another chat (UMD) */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('../inventory/action-button'));
    return;
  }
  root.rendererAdmissionWaitLine = factory(root.inventoryActionButton);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (actionButton) {
  'use strict';
  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  /* F20 (owner option A): a send the runtime has not admitted because another
     chat holds the model (`admission_wait` model_busy, past the grace that
     renderer-stuck-send.js applies) showed only its user bubble. One quiet line
     where the reply will appear names that chat and links to it. It wears the
     in-stream waiting line's grammar (renderer-stream-waiting-line.js); the
     queue strip keeps Withdraw. It goes once the wait ends: admitted work is
     no longer pending, so its wait is null. */
  const LINE_ATTR = 'data-admission-wait-line';
  // Stands in for the title inside the translated sentence (see the waiting line).
  const TITLE_TOKEN = '';

  function normalizeId(value) {
    return String(value == null ? '' : value).trim();
  }

  // A chat paused on an approval waits for the person, not for its reply.
  function isPausedOnApproval(state, sessionId) {
    const approvals = typeof state?.pendingToolApprovals?.values === 'function' ? [...state.pendingToolApprovals.values()] : [];
    return approvals.some((approval) => normalizeId(approval?.sessionId) === sessionId);
  }

  // The stored placeholder of a chat not titled yet ('New Chat'; the localized
  // label is display-only) names nothing, so it reads as untitled.
  function isPlaceholderTitle(title) {
    return title === 'New Chat' || title === jt('session.defaultTitle.chat', 'New Chat');
  }

  function sessionTitle(state, sessionId) {
    const session = (Array.isArray(state?.sessions) ? state.sessions : []).find((entry) => entry?.id === sessionId);
    const title = normalizeId(session?.title);
    return isPlaceholderTitle(title) ? '' : title;
  }

  // The words of the line: `before` + linked title + `after`. Also read by the
  // queue strip, so both surfaces say the same thing about the same wait.
  function waitCopy(state, blockingSessionId) {
    const title = blockingSessionId ? sessionTitle(state, blockingSessionId) : '';
    const approval = Boolean(blockingSessionId) && isPausedOnApproval(state, blockingSessionId);
    if (!title) {
      return { before: approval
        ? jt('chat.admissionWait.approvalUntitled', 'Waiting for another chat that is paused on your approval.')
        : jt('chat.admissionWait.otherChatUntitled', 'Waiting for another chat to finish its reply.'), linked: '', after: '' };
    }
    const sentence = approval
      ? jt('chat.admissionWait.approval', 'Waiting for another chat: "{title}" is paused on your approval.', { title: TITLE_TOKEN })
      : jt('chat.admissionWait.otherChat', 'Waiting for "{title}" to finish its reply.', { title: TITLE_TOKEN });
    const at = sentence.indexOf(TITLE_TOKEN);
    if (at < 0) return { before: sentence, linked: '', after: '' };
    return { before: sentence.slice(0, at), linked: title, after: sentence.slice(at + TITLE_TOKEN.length) };
  }

  function waitText(state, blockingSessionId) {
    const copy = waitCopy(state, blockingSessionId);
    return copy.before + copy.linked + copy.after;
  }

  function buildLine(documentRef, copy, blockingSessionId, onOpenChat) {
    const node = documentRef.createElement('div');
    node.className = 'turn-activity-row';
    node.setAttribute(LINE_ATTR, 'true');
    node.setAttribute('data-turn-activity-kind', 'waiting');
    node.setAttribute('role', 'status');
    const dot = documentRef.createElement('span');
    dot.className = 'status-dot status-dot--active turn-activity-dot';
    dot.setAttribute('aria-hidden', 'true');
    node.appendChild(dot);
    const label = documentRef.createElement('span');
    label.className = 'turn-activity-label';
    const why = documentRef.createElement('span');
    why.className = 'turn-activity-wait-why';
    why.appendChild(documentRef.createTextNode(copy.before));
    if (copy.linked) {
      const wrapper = documentRef.createElement('span');
      wrapper.innerHTML = actionButton({ label: copy.linked, className: 'turn-activity-wait-link',
        title: jt('chat.runtimeQueue.openBlocking', 'Open that chat'), plain: true });
      const link = wrapper.firstElementChild;
      link.addEventListener('click', (event) => {
        event.preventDefault();
        try { onOpenChat?.(blockingSessionId); } catch (_error) { /* affordance only */ }
      });
      why.appendChild(link);
      why.appendChild(documentRef.createTextNode(copy.after));
    }
    label.appendChild(why);
    node.appendChild(label);
    return node;
  }

  /**
   * Shows, refreshes or removes the line in `timeline` for the conversation's
   * pending sends (`rows` from the durable send controller's listPending, whose
   * `wait` is already past its grace). Rebuilt only when its words change, so a
   * render never replaces the link under the pointer or the keyboard.
   */
  function syncAdmissionWaitLine({ timeline, state, rows, onOpenChat } = {}) {
    if (!timeline || typeof timeline.querySelector !== 'function') return null;
    const existing = timeline.querySelector(`[${LINE_ATTR}]`);
    const held = (Array.isArray(rows) ? rows : []).find((row) => row?.wait?.reason === 'model_busy');
    if (!held) {
      existing?.remove();
      return null;
    }
    const blockingSessionId = normalizeId(held.wait.blockingSessionId);
    const copy = waitCopy(state, blockingSessionId);
    const key = [blockingSessionId, copy.before, copy.linked, copy.after].join('\n');
    let node = existing;
    if (!node || node.getAttribute('data-wait-key') !== key) {
      existing?.remove();
      node = buildLine(timeline.ownerDocument, copy, blockingSessionId, onOpenChat);
      node.setAttribute('data-wait-key', key);
    }
    // Where the reply will appear: after everything the timeline renders.
    if (node.parentNode !== timeline || node !== timeline.lastElementChild) timeline.appendChild(node);
    return node;
  }

  return { syncAdmissionWaitLine, waitCopy, waitText };
});
