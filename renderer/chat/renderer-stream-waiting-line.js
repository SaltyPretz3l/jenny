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
     (dogfood HB-034 F5).
     Row 136: a reply that is running but whose next model request waits for
     another chat is reported on its live stream as `model_waiting` (waitState
     waiting, then granted). It reads as a wait too (waitState `model` here),
     with one action, "Finish this first"; the reply is not paused, so the
     composer and the queue strip treat it as running. */

  // Stands in for the other chat's title inside the translated sentence, so
  // the title can be a control without splitting the sentence into fragments.
  const TITLE_TOKEN = '';

  function normalizeId(value) {
    return String(value == null ? '' : value).trim();
  }

  // The stored placeholder of a chat whose generated title has not arrived
  // ('New Chat'; the localized label is display-only) names nothing, so the
  // line reads as it does for an untitled chat.
  function isPlaceholderTitle(title) {
    return title === 'New Chat' || title === jt('session.defaultTitle.chat', 'New Chat');
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

  // A sentence cut at the title's place, so the title can be a control.
  function splitAtTitle(sentence, title, sub) {
    const at = sentence.indexOf(TITLE_TOKEN);
    return at < 0 ? { before: sentence, linked: '', after: '', sub }
      : { before: sentence.slice(0, at), linked: title, after: sentence.slice(at + TITLE_TOKEN.length), sub };
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
    if (named) return splitAtTitle(named, title, sub);
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

  // The words of a wait for the model behind another chat (row 136). `first`:
  // this chat was put first and only waits for the other chat's running step.
  function modelWaitCopy(typed, title, first) {
    let sentence;
    let sub = jt('chat.streamActivity.continuesOnItsOwn', 'Continues on its own.');
    if (typed.heldForFirst && !first) {
      sub = jt('chat.streamActivity.modelWait.continuesWhenDone', 'Continues when it is done.');
      if (!title) sentence = jt('chat.streamActivity.modelWait.firstOther', 'Waiting for the chat that goes first.');
      else if (typed.firstSetBy === 'primary') sentence = jt('chat.streamActivity.modelWait.firstChatByJenny', 'Waiting for "{title}". Jenny put it first.', { title: TITLE_TOKEN });
      else sentence = jt('chat.streamActivity.modelWait.firstChat', 'Waiting for "{title}", which goes first.', { title: TITLE_TOKEN });
    } else {
      if (first) sub = jt('chat.streamActivity.modelWait.goesNext', 'This chat goes next.');
      sentence = title
        ? jt('chat.streamActivity.modelWait.chat', 'Waiting for the model while "{title}" uses it.', { title: TITLE_TOKEN })
        : jt('chat.streamActivity.modelWait.otherChat', 'Waiting for the model while another chat uses it.');
    }
    return splitAtTitle(sentence, title, sub);
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
    if (isPlaceholderTitle(title)) title = '';
    const model = typed.waitState === 'model';
    let first = false;
    if (model && typeof options.isFirstChat === 'function') {
      try { first = options.isFirstChat(entry.sessionId) === true; } catch (_error) { first = false; }
    }
    const hover = holderTitle(typed);
    const key = [typed.waitState, typed.blockingSessionId, title, JSON.stringify(typed.holder),
      typed.heldForFirst, typed.firstSetBy, first].join('\n');
    if (label.getAttribute('data-wait-key') === key) return;
    label.setAttribute('data-wait-key', key);
    if (hover) label.title = hover;
    else label.removeAttribute('title');
    label.classList.remove('turn-activity-label--path');
    label.textContent = '';
    const copy = model ? modelWaitCopy(typed, title, first) : waitingCopy(typed, title);
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
    if (model && !first) {
      const sessionId = entry.sessionId;
      label.appendChild(documentRef.createTextNode(' '));
      label.appendChild(createButton(documentRef, jt('chat.firstChat.finishFirst', 'Finish this first'),
        'turn-activity-wait-action',
        jt('chat.firstChat.finishFirstHint', 'Give this chat the model until its task is done. The other chat\'s current step is not cut off.'),
        () => options.onFinishFirst?.(sessionId)));
    }
  }

  function isWaiting(entry) {
    return entry?.typed?.kind === 'waiting';
  }

  // A running reply whose model request waits behind another chat (row 136).
  function isModelWait(entry) {
    return isWaiting(entry) && entry.typed.waitState === 'model';
  }

  function isPausedWait(entry) {
    return isWaiting(entry) && !isModelWait(entry);
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
    // The wait began at its first notice; a later one only updates why.
    const startedAt = isWaiting(entry) ? entry.typed.startedAt : entry.lastEventAt;
    if (normalizeId(payload && payload.type) === 'model_waiting') {
      // A reply that has paused since is no longer asking for the model: its own line stands.
      if (isPausedWait(entry)) return true;
      if (waitState !== 'waiting') {
        // Granted: the reply runs on, and the busy copy may speak for it again.
        entry.typed = null;
        return false;
      }
      entry.typed = {
        kind: 'waiting',
        waitState: 'model',
        blockingSessionId: normalizeId(payload.blockingSessionId),
        heldForFirst: payload.heldForFirst === true,
        firstSetBy: normalizeId(payload.firstSetBy),
        startedAt,
      };
      entry.armed = true;
      return true;
    }
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
      startedAt,
    };
    entry.armed = true;
    entry.waitEnded = false;
    return true;
  }

  // A waiting reply resumes under a NEW stream id and the paused stream never
  // gets a terminal: the session's next `started` ends the wait it replaces.
  function releaseSessionWaits(tracked, sessionId, startedStreamId, untrack) {
    for (const [streamId, entry] of [...tracked.entries()]) {
      if (streamId !== startedStreamId && entry.sessionId === sessionId && (isPausedWait(entry) || entry.waitEnded)) {
        untrack(streamId);
      }
    }
  }

  // Read by the composer chrome (Pause hides: nothing is running) and by the
  // queue strip (no "Paused reply" row for a wait that ends by itself).
  function createQueries(tracked) {
    return {
      isWaitingStream: (streamId) => isPausedWait(tracked.get(normalizeId(streamId))),
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

  // Row 136: which chat goes first on the model. Main owns the pick and ends
  // it without an event (60 s after the chat's task), so this is a read-through
  // copy: read after a set or clear made here, on a model-wait notice, on a
  // reply's start and end (the activity row calls `refresh`), and every
  // FIRST_RECHECK_MS for as long as a pick is shown. A bridge without the
  // method (hosted) reads as nobody first.
  const FIRST_RECHECK_MS = 15_000;
  function createFirstChat({ api = () => globalThis.jennyShell && globalThis.jennyShell.chat, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
    let first = null; // { sessionId, setBy } | null
    let recheck = null;
    const listeners = new Set();
    function apply(result) {
      const next = result && result.first && normalizeId(result.first.sessionId)
        ? { sessionId: normalizeId(result.first.sessionId), setBy: normalizeId(result.first.setBy) || 'user' } : null;
      if ((first && first.sessionId) === (next && next.sessionId) && (first && first.setBy) === (next && next.setBy)) return;
      first = next;
      for (const listener of [...listeners]) {
        try { listener(first); } catch (_error) { /* one view cannot block another */ }
      }
    }
    async function call(action, sessionId) {
      try {
        const result = await api().firstSession({ action, sessionId: normalizeId(sessionId) });
        apply(result);
        // Every answer that shows a pick books the next read; the read that finds none ends the chain.
        if (recheck) clearTimer(recheck);
        recheck = first ? setTimer(() => { recheck = null; call('get', ''); }, FIRST_RECHECK_MS) : null;
        return result;
      } catch (_error) {
        return null; // no bridge, or a failed read: what is shown stays until the next read
      }
    }
    return {
      get: () => first,
      isFirst: (sessionId) => Boolean(first) && first.sessionId === normalizeId(sessionId),
      refresh: () => call('get', ''),
      set: (sessionId) => call('set', sessionId),
      clear: (sessionId) => call('clear', sessionId),
      subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };
  }
  const firstChat = createFirstChat();

  // The sidebar row's tag for the chat that goes first, or null.
  function firstChatRowTag(sessionId, store = firstChat) {
    if (!store.isFirst(sessionId)) return null;
    return {
      label: jt('chat.firstChat.tag', 'First'),
      title: store.get().setBy === 'primary'
        ? jt('chat.firstChat.tagHintByJenny', 'Jenny put this chat first. Other chats wait for the model until its task is done.')
        : jt('chat.firstChat.tagHint', 'This chat goes first. Other chats wait for the model until its task is done.'),
    };
  }

  // The sidebar row menu's top item: lift the pick on the chat that is first,
  // or put a chat with a reply running first. Nothing for an idle chat.
  function firstChatMenuItems(sessionId, running, store = firstChat) {
    if (store.isFirst(sessionId)) {
      return [{ label: jt('chat.firstChat.takeTurns', 'Take turns again'), action: () => store.clear(sessionId) }];
    }
    return running === true
      ? [{ label: jt('chat.firstChat.finishFirst', 'Finish this first'), action: () => store.set(sessionId) }]
      : [];
  }

  // Stream-handler side: what the line needs from the app, and what the
  // composer must redo when a wait starts, changes or ends.
  function createWaitingRowWiring({ state, queueSessionRender = () => {}, firstChat: firstChatOf = () => firstChat } = {}) {
    const controller = () => state && state.runtimeSendController;
    return {
      rowOptions: {
        isFirstChat: (sessionId) => firstChatOf().isFirst(sessionId),
        onFinishFirst: (sessionId) => firstChatOf().set(sessionId),
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

  return { applyNotice, createFirstChat, createQueries, createWaitingRowWiring, firstChat, firstChatMenuItems, firstChatRowTag,
    isModelWait, isWaiting, releaseLabel, releaseSessionWaits, renderRow, waitingCopy };
});
