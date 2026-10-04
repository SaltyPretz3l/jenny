/* renderer/chat/renderer-stream-waiting-line.js – the activity row's line for a reply that waits by itself (UMD) */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('../inventory/action-button'));
    return;
  }
  root.rendererStreamWaitingLine = factory(root.inventoryActionButton);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (actionButton) {
  'use strict';
  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  /* A reply can pause by itself because a resource it needs is held elsewhere,
     usually another chat's command in the same folder. Main reports that on the
     paused stream as `runtime_waiting` (services/backend/runtime-wait-notices.js)
     with waitState:
       waiting  continues by itself when the holder finishes
       stuck    the holder is a stopped command whose cleanup was never
                confirmed; only an engine restart clears it
       ended    no longer resumed automatically: the reply is paused, and the
                queue strip's "Paused reply" row is the way forward
     The activity row (renderer-stream-activity-row.js) owns the tracked entry
     and the node; this module owns what a waiting entry is and how it reads.
     It is not silence: the busy copy never shows for a waiting or ended stream
     (dogfood HB-034 F5). */

  // Stands in for the other chat's title inside the translated sentence, so
  // the title can be a control without splitting the sentence into fragments.
  const TITLE_TOKEN = '';

  function normalizeId(value) {
    return String(value == null ? '' : value).trim();
  }

  // The words of a waiting line: `before` + linked title + `after`, then `sub`.
  function waitingCopy(typed, title) {
    if (typed.waitState === 'stuck') {
      return {
        before: jt('chat.streamActivity.waitingStuck', 'Waiting on a stopped command that never confirmed it ended.'),
        linked: '',
        after: '',
        sub: jt('chat.streamActivity.waitingStuckHint', 'Restart the engine to clear it, or stop this reply.'),
      };
    }
    const sub = jt('chat.streamActivity.continuesOnItsOwn', 'Continues on its own.');
    if (typed.blockingSessionId && title) {
      const sentence = jt('chat.streamActivity.waitingForChat', 'Waiting for "{title}" to finish a command in this folder.', { title: TITLE_TOKEN });
      const at = sentence.indexOf(TITLE_TOKEN);
      if (at >= 0) {
        return { before: sentence.slice(0, at), linked: title, after: sentence.slice(at + TITLE_TOKEN.length), sub };
      }
    }
    return {
      before: typed.blockingSessionId
        ? jt('chat.streamActivity.waitingForOtherChat', 'Waiting for another chat to finish a command in this folder.')
        : jt('chat.streamActivity.waitingForOtherWork', 'Waiting for other work to finish.'),
      linked: '',
      after: '',
      sub,
    };
  }

  function createButton(documentRef, label, className, title, handler) {
    const wrapper = documentRef.createElement('span');
    wrapper.innerHTML = actionButton({ label, className, title, plain: true });
    const button = wrapper.firstElementChild;
    button.addEventListener('click', (event) => {
      event.preventDefault();
      try { handler(); } catch (_error) { /* affordance only */ }
    });
    return button;
  }

  // Built once per distinct wait (state, blocker, title): the row's 500 ms
  // tick must not replace a control the pointer or the keyboard is on.
  function renderLabel(documentRef, label, entry, options) {
    const typed = entry.typed;
    let title = '';
    if (typed.blockingSessionId && typeof options.getSessionTitle === 'function') {
      try { title = normalizeId(options.getSessionTitle(typed.blockingSessionId)); } catch (_error) { title = ''; }
    }
    const key = [typed.waitState, typed.blockingSessionId, title].join('\n');
    if (label.getAttribute('data-wait-key') === key) return;
    label.setAttribute('data-wait-key', key);
    label.classList.remove('turn-activity-label--path');
    label.textContent = '';
    const copy = waitingCopy(typed, title);
    const why = documentRef.createElement('span');
    why.className = 'turn-activity-wait-why';
    why.appendChild(documentRef.createTextNode(copy.before));
    if (copy.linked) {
      const blockingSessionId = typed.blockingSessionId;
      why.appendChild(createButton(documentRef, copy.linked, 'turn-activity-wait-link',
        jt('chat.runtimeQueue.openBlocking', 'Open that chat'), () => options.onOpenChat?.(blockingSessionId)));
      why.appendChild(documentRef.createTextNode(copy.after));
    }
    label.appendChild(why);
    label.appendChild(documentRef.createTextNode(' '));
    const sub = documentRef.createElement('span');
    sub.className = 'turn-activity-wait-sub';
    sub.textContent = copy.sub;
    label.appendChild(sub);
    if (typed.waitState === 'stuck') {
      const sessionId = entry.sessionId;
      label.appendChild(documentRef.createTextNode(' '));
      label.appendChild(createButton(documentRef, jt('chat.stuckSend.restartEngine', 'Restart engine'),
        'turn-activity-wait-action', '', () => options.onRestartEngine?.(sessionId)));
    }
  }

  function isWaiting(entry) {
    return entry?.typed?.kind === 'waiting';
  }

  // Draws a waiting entry into the activity row's node: no name, the sentence,
  // and the time since the wait began (the shared 1s clock owns it between ticks).
  function renderRow(node, entry, timestamp, options) {
    node.setAttribute('data-turn-activity-kind', entry.typed.waitState === 'stuck' ? 'waiting-stuck' : 'waiting');
    const nameNode = node.querySelector('.turn-activity-name');
    if (nameNode) {
      nameNode.hidden = true;
      if (nameNode.textContent) nameNode.textContent = '';
    }
    const label = node.querySelector('.turn-activity-label');
    if (label) renderLabel(node.ownerDocument, label, entry, options);
    const elapsed = node.querySelector('.turn-activity-elapsed');
    if (elapsed) {
      elapsed.setAttribute('data-turn-elapsed', 'true');
      elapsed.setAttribute('data-elapsed-started-at', String(entry.typed.startedAt));
      const text = options.formatElapsedLabel(timestamp - entry.typed.startedAt);
      if (elapsed.textContent !== text) elapsed.textContent = text;
    }
  }

  // A node that showed a wait holds its parts; plain text takes it back.
  function releaseLabel(label) {
    if (!label || !label.hasAttribute('data-wait-key')) return;
    label.removeAttribute('data-wait-key');
    label.textContent = '';
  }

  // Applies one `runtime_waiting` notice to the stream's tracked entry.
  // Returns true while the reply waits; false once the wait has ended without
  // a resume (the entry is disarmed so the busy copy cannot come back for it).
  function applyNotice(entry, payload) {
    const waitState = normalizeId(payload && payload.waitState);
    if (waitState !== 'waiting' && waitState !== 'stuck') {
      entry.typed = null;
      entry.armed = false;
      entry.waitEnded = true;
      return false;
    }
    entry.typed = {
      kind: 'waiting',
      waitState,
      workId: normalizeId(payload && payload.workId),
      blockingSessionId: normalizeId(payload && payload.blockingSessionId),
      // The wait began at its first notice; a later one only updates why.
      startedAt: isWaiting(entry) ? entry.typed.startedAt : entry.lastEventAt,
    };
    entry.armed = true;
    entry.waitEnded = false;
    return true;
  }

  // A waiting reply resumes under a NEW stream id and the paused stream never
  // gets a terminal: the session's next `started` ends the wait it replaces.
  function releaseSessionWaits(tracked, sessionId, startedStreamId, untrack) {
    for (const [streamId, entry] of [...tracked.entries()]) {
      if (streamId !== startedStreamId && entry.sessionId === sessionId && (isWaiting(entry) || entry.waitEnded)) {
        untrack(streamId);
      }
    }
  }

  // Read by the composer chrome (Pause hides: nothing is running) and by the
  // queue strip (no "Paused reply" row for a wait that ends by itself).
  function createQueries(tracked) {
    return {
      isWaitingStream: (streamId) => isWaiting(tracked.get(normalizeId(streamId))),
      isWaitingWork(workId) {
        const id = normalizeId(workId);
        if (!id) return false;
        for (const entry of tracked.values()) {
          if (isWaiting(entry) && entry.typed.workId === id) return true;
        }
        return false;
      },
    };
  }

  // Stream-handler side: what the line needs from the app, and what the
  // composer must redo when a wait starts, changes or ends.
  function createWaitingRowWiring({ state, queueSessionRender = () => {} } = {}) {
    const controller = () => state && state.runtimeSendController;
    return {
      rowOptions: {
        getSessionTitle: (sessionId) => String((Array.isArray(state?.sessions) ? state.sessions : [])
          .find((entry) => entry?.id === sessionId)?.title || '').trim(),
        onOpenChat: (sessionId) => controller()?.openChat?.(sessionId),
        onRestartEngine: (sessionId) => controller()?.restartEngine?.(sessionId),
      },
      async handleRuntimeWaiting(payload) {
        const sessionId = normalizeId(payload && payload.sessionId);
        const waitState = normalizeId(payload && payload.waitState);
        // A wait that stopped being automatic is a paused reply: the strip
        // reads the session's rows again so its Resume row can appear.
        if (waitState !== 'waiting' && waitState !== 'stuck') {
          try { await controller()?.refreshSessionRows?.(sessionId); } catch (_error) { /* the strip's own reads retry */ }
        }
        // Pause hides and the strip drops its row while a reply waits.
        queueSessionRender(sessionId, { composer: true, composerStatus: true });
        return { buffered: false, terminal: false };
      },
    };
  }

  return { applyNotice, createQueries, createWaitingRowWiring, isWaiting, releaseLabel, releaseSessionWaits, renderRow, waitingCopy };
});
