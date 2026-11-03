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

  // Row 100 P2 (owner pick B): who holds a work lease, in plain words; the
  // command and the process are the line's hover text. A kind or work this
  // table does not know keeps the older sentences.
  // One literal call per string, so the string ledger can read each default.
  // By holder kind, then by the holder's work; `other_chat` is a chat with no title.
  const HOLDER_COPY = {
    chat: {
      tests: (p) => jt('chat.streamActivity.holder.chatTests', 'Waiting for "{title}" to finish its tests.', p),
      git_change: (p) => jt('chat.streamActivity.holder.chatGit', 'Waiting for "{title}" to finish a git change.', p),
      install: (p) => jt('chat.streamActivity.holder.chatInstall', 'Waiting for "{title}" to finish an install.', p),
    },
    other_chat: {
      tests: () => jt('chat.streamActivity.holder.otherChatTests', 'Waiting for another chat to finish its tests.'),
      git_change: () => jt('chat.streamActivity.holder.otherChatGit', 'Waiting for another chat to finish a git change.'),
      install: () => jt('chat.streamActivity.holder.otherChatInstall', 'Waiting for another chat to finish an install.'),
    },
    jenny_window: {
      tests: () => jt('chat.streamActivity.holder.windowTests', 'Waiting for another Jenny window to finish its tests.'),
      git_change: () => jt('chat.streamActivity.holder.windowGit', 'Waiting for another Jenny window to finish a git change.'),
      install: () => jt('chat.streamActivity.holder.windowInstall', 'Waiting for another Jenny window to finish an install.'),
    },
    claude_code: {
      tests: () => jt('chat.streamActivity.holder.claudeTests', 'Waiting for a Claude Code session to finish its tests.'),
      git_change: () => jt('chat.streamActivity.holder.claudeGit', 'Waiting for a Claude Code session to finish a git change.'),
      install: () => jt('chat.streamActivity.holder.claudeInstall', 'Waiting for a Claude Code session to finish an install.'),
    },
  };

  function holderSentence(typed, title) {
    const holder = typed.holder;
    if (!holder) return null;
    if (holder.count > 1) {
      return holder.kind === 'chat' && title
        ? jt('chat.streamActivity.holder.chatAndMore', 'Waiting for "{title}" and {count} more to finish.', { title: TITLE_TOKEN, count: holder.count - 1 })
        : jt('chat.streamActivity.holder.several', 'Waiting for {count} runs to finish.', { count: holder.count });
    }
    if (holder.kind === 'test_run') return jt('chat.streamActivity.holder.testRun', 'Waiting for a test run outside Jenny to finish.');
    if (holder.kind === 'git') return jt('chat.streamActivity.holder.gitLock', 'Waiting for another git command in this repository to finish.');
    const kind = holder.kind === 'chat' && !title ? 'other_chat' : holder.kind;
    const copy = Object.hasOwn(HOLDER_COPY, kind) && Object.hasOwn(HOLDER_COPY[kind], holder.what) ? HOLDER_COPY[kind][holder.what] : null;
    return copy ? copy({ title: TITLE_TOKEN }) : null;
  }

  // The hover text of a work-lease wait: the holder's command and its process.
  function holderTitle(typed) {
    const holder = typed.holder;
    if (!holder) return '';
    const parts = [];
    if (holder.label) parts.push(holder.label);
    if (holder.pid) parts.push(jt('chat.streamActivity.holder.process', 'process {pid}', { pid: holder.pid }));
    return parts.join(' · ');
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
    const named = holderSentence(typed, typed.blockingSessionId ? title : '');
    if (named) {
      const at = named.indexOf(TITLE_TOKEN);
      return at < 0 ? { before: named, linked: '', after: '', sub }
        : { before: named.slice(0, at), linked: title, after: named.slice(at + TITLE_TOKEN.length), sub };
    }
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
    const hover = holderTitle(typed);
    const key = [typed.waitState, typed.blockingSessionId, title, JSON.stringify(typed.holder)].join('\n');
    if (label.getAttribute('data-wait-key') === key) return;
    label.setAttribute('data-wait-key', key);
    if (hover) label.title = hover;
    else label.removeAttribute('title');
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
    label.removeAttribute('title');
    label.textContent = '';
  }

  // A work-lease wait's holder from the notice (row 100 P2), or null.
  function holderOf(payload) {
    const kind = normalizeId(payload && payload.holderKind);
    if (!kind) return null;
    const count = Number(payload.holderCount);
    const pid = Number(payload.holderPid);
    return {
      kind,
      what: normalizeId(payload.holderWhat),
      label: normalizeId(payload.holderLabel).slice(0, 120),
      pid: Number.isSafeInteger(pid) && pid > 0 ? pid : null,
      count: Number.isSafeInteger(count) && count > 0 ? count : 1,
      jobIds: Array.isArray(payload.holderJobIds) ? payload.holderJobIds.map(normalizeId).filter(Boolean).slice(0, 8) : [],
    };
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
      holder: holderOf(payload),
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
      // The chats waiting behind one of this app's background jobs (row 100 P2, the rail's "N waiting").
      waitersForJob(jobId) {
        const id = normalizeId(jobId);
        const sessions = new Set();
        if (!id) return [];
        for (const entry of tracked.values()) {
          if (isWaiting(entry) && entry.typed.waitState === 'waiting' && entry.typed.holder?.jobIds.includes(id)) sessions.add(entry.sessionId);
        }
        return [...sessions].filter(Boolean);
      },
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
