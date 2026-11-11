(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererSpriteActivity = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const SPRITE_ACTIVITIES = Object.freeze([
    'think', 'write', 'compose', 'check', 'search', 'make', 'run', 'tool', 'compact',
    'wait', 'stuck', 'approve', 'done', 'rest', 'stopped', 'error',
  ]);

  const SEARCH_VERBS = new Set(['read', 'list', 'search', 'web', 'fetch']);
  // Tool plumbing rows: never the prose anchor the rail sprite sits beside.
  const SPRITE_NON_CONTENT_KINDS = new Set(['tool_use', 'tool_result']);
  // An artifact is a made file too; its tool has no run verb of its own.
  const MAKE_TOOLS = new Set(['create_artifact']);
  const EXECUTING_STATUSES = new Set(['running', 'executing']);
  // A tool that ran this recently still counts as running: a 1 ms read settles
  // before the pipeline samples it, and the morph's hold then shows its form.
  const JUST_RAN_MS = 300;
  const LIVE_LIFECYCLES = new Set(['preflight', 'streaming']);
  const AWAITING_APPROVAL_STATUS = 'awaiting_approval';
  const PENDING_QUESTION_STATUS = 'pending_user_input';

  function asArray(value) {
    return Array.isArray(value) ? value : [];
  }

  function asObject(value) {
    return value && typeof value === 'object' ? value : {};
  }

  function str(value) {
    return typeof value === 'string' ? value : '';
  }

  function token(value) {
    return String(value == null ? '' : value).trim();
  }

  function result(activity, live) {
    return { activity, live: live === true };
  }

  function deriveSettled(source) {
    const admissionWait = source.admissionWait;
    if (admissionWait && typeof admissionWait === 'object') {
      return result(str(admissionWait.reason) === 'cleanup_unconfirmed' ? 'stuck' : 'wait', false);
    }
    if (source.stoppedWithoutTerminal === true) return result('stopped', false);
    const outcome = str(source.outcome);
    if (outcome === 'error') return result('error', false);
    if (outcome === 'cancelled') return result('stopped', false);
    return result('rest', false);
  }

  function deriveApproval(source) {
    let paused = false;
    for (const ref of asArray(source.approvalRefs)) {
      const state = str(asObject(ref).state);
      if (state === 'live') return 'approve';
      if (state === 'paused') paused = true;
    }
    if (source.questionPending === true) return 'approve';
    return paused ? 'wait' : '';
  }

  // The newest executing tool; failing that, the newest that just ran.
  function lastExecutingTool(runningTools) {
    const tools = asArray(runningTools).map(asObject).reverse();
    return tools.find((tool) => EXECUTING_STATUSES.has(str(tool.status)))
      || tools.find((tool) => tool.justRan === true) || null;
  }

  function toolForm(tool) {
    const verb = str(tool.verb);
    if (SEARCH_VERBS.has(verb)) return 'search';
    if (verb === 'edit' || MAKE_TOOLS.has(str(tool.toolName))) return 'make';
    return verb === 'run' ? 'run' : 'tool';
  }

  function deriveLive(source) {
    const approval = deriveApproval(source);
    if (approval) return result(approval, true);

    const typed = asObject(source.typed);
    const typedKind = str(typed.kind);
    if (typedKind === 'waiting') {
      return result(str(typed.waitState) === 'stuck' ? 'stuck' : 'wait', true);
    }
    if (typedKind === 'compaction') return result('compact', true);

    const tool = lastExecutingTool(source.runningTools);
    if (tool) return result(toolForm(tool), true);

    if (typedKind === 'tool_input') return result(typed.checklist ? 'check' : 'compose', true);

    const deltaKind = str(source.deltaKind);
    if (deltaKind === 'prose') return result('write', true);
    return result('think', true);
  }

  function deriveSpriteActivity(input) {
    const source = asObject(input);
    return source.turnLive === true ? deriveLive(source) : deriveSettled(source);
  }

  function createSpriteActivityTracker() {
    let record = null;

    function derive(input, options) {
      const opts = asObject(options);
      // The caller's `${paneId}|${sessionId}|${userMessageId}` key for the turn.
      const turnKey = str(opts.turnKey);
      const derived = deriveSpriteActivity(input);
      if (derived.live) {
        if (opts.visible === true && turnKey) record = { turnKey };
        return derived;
      }
      // A stop or error ends the turn: a late reconciled complete must not play done.
      if (derived.activity === 'stopped' || derived.activity === 'error') record = null;
      const outcome = str(asObject(input).outcome);
      const isComplete = derived.activity === 'rest' && outcome === 'complete';
      if (isComplete && record && turnKey && record.turnKey === turnKey) {
        record = null;
        return result('done', false);
      }
      return derived;
    }

    function invalidate() {
      record = null;
    }

    function peek() {
      return record ? Object.freeze({ ...record }) : null;
    }

    return { derive, invalidate, peek };
  }

  function collectTurnRefs(rows, sessionId, normalizeStatus) {
    const refs = [];
    let questionPending = false;
    for (const message of rows) {
      const row = asObject(message);
      const ref = (callId) => ({ callId: token(callId), sessionId, turnId: token(row.turn_id), rowState: '' });
      if (row.kind === 'tool_use') {
        const call = asObject(row.tool_call);
        const status = normalizeStatus(call.status);
        if (status === AWAITING_APPROVAL_STATUS) refs.push(ref(call.call_id));
        else if (status === PENDING_QUESTION_STATUS && call.user_questions_withdrawn !== true) questionPending = true;
      } else if (row.kind === 'plan_document' && asObject(row.plan_document).state === 'pending') {
        refs.push(ref(row.plan_document.tool_call_id));
      }
    }
    return { refs, questionPending };
  }

  // The wait of the pending send for the pane's latest user turn. An optimistic user
  // message has no turn id until admission, so it also matches the entry's user id.
  function findAdmissionWait(sendController, sessionId, latestUser) {
    const rows = asArray(sendController?.listPending?.(sessionId));
    const userId = token(latestUser.id);
    const turnId = token(latestUser.turn_id);
    for (const row of rows) {
      const entry = asObject(row);
      const sameTurn = Boolean(turnId) && token(entry.turnId) === turnId;
      const sameUser = Boolean(userId) && token(entry.userId) === userId;
      if ((sameTurn || sameUser) && entry.wait && typeof entry.wait === 'object') return entry.wait;
    }
    return null;
  }

  // Optimistic user rows of sends not yet admitted. While a stream is live they are
  // queued behind it, so they are not the turn the sprite shows.
  function queuedUserIds(sendController, sessionId) {
    return new Set(asArray(sendController?.listPending?.(sessionId))
      .filter((row) => asObject(row).admitted !== true)
      .map((row) => token(asObject(row).userId))
      .filter(Boolean));
  }

  function latestUserIndex(messages, skipIds = null) {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = asObject(messages[index]);
      if (message.role === 'user' && !skipIds?.has(token(message.id))) return index;
    }
    return -1;
  }

  // The pane's own send controller: pane 0's is the state slot; a split pane passes its own.
  function sendControllerOf(source) {
    return source.runtimeSendController || asObject(source.state).runtimeSendController || null;
  }

  function isSessionStreamLive(streams, sessionId) {
    const sessionStreamId = token(streams?.getStreamIdForSession?.(sessionId));
    return Boolean(sessionStreamId) && streams.isStreamFinalized?.(sessionStreamId) !== true;
  }

  // The admission wait for the pane's latest user turn while no stream is live. A
  // durable send registers no preflight, so the pipeline also anchors on this.
  function findPaneAdmissionWait(deps, paneSessionId, messages) {
    const source = asObject(deps);
    const streams = source.multiStreamController || globalThis.rendererMultiStreamController || null;
    const sessionId = token(paneSessionId);
    const rows = asArray(messages);
    const userIndex = latestUserIndex(rows);
    if (userIndex < 0 || isSessionStreamLive(streams, sessionId)) return null;
    return findAdmissionWait(sendControllerOf(source), sessionId, asObject(rows[userIndex]));
  }

  // Reads live renderer state for one pane. `anchor` is { messages, streamId, status, outcome }:
  // the pane's messages, the stream the pipeline resolved, and the anchor bubble's status and outcome.
  function gatherSpriteActivityInput(deps, paneSessionId, anchor) {
    const source = asObject(deps);
    const state = asObject(source.state);
    const streams = source.multiStreamController || globalThis.rendererMultiStreamController || null;
    const toolUtils = source.toolCallUtils || globalThis.toolCallUtils || null;
    const approvalBlock = source.approvalBlock || globalThis.rendererApprovalBlock || null;
    const target = asObject(anchor);
    const sessionId = token(paneSessionId);
    const streamId = token(target.streamId);
    const messages = asArray(target.messages);
    const normalizeStatus = (value) => (typeof toolUtils?.normalizeToolStatus === 'function'
      ? toolUtils.normalizeToolStatus(value) : token(value).toLowerCase());

    const lifecycle = token(state.ui?.chatSendLifecycleBySession?.get?.(sessionId));
    const streamLive = isSessionStreamLive(streams, sessionId);
    const stoppedWithoutTerminal = Boolean(streamId)
      && streams?.isStreamFinalized?.(streamId) === true
      && streams.isStreamTerminalSettled?.(streamId) !== true
      && token(target.status) === 'streaming';

    const sendController = sendControllerOf(source);
    const userIndex = latestUserIndex(messages, streamLive ? queuedUserIds(sendController, sessionId) : null);
    const turnRows = userIndex >= 0 ? messages.slice(userIndex + 1) : [];
    const { refs, questionPending } = collectTurnRefs(turnRows, sessionId, normalizeStatus);
    const approvalRefs = refs.map((ref) => ({
      state: asObject(approvalBlock?.resolveApprovalCardState?.(state, ref)).state || 'live',
    }));
    const pendingApprovals = typeof state.pendingToolApprovals?.values === 'function'
      ? [...state.pendingToolApprovals.values()] : [];
    for (const approval of pendingApprovals) {
      if (token(asObject(approval).sessionId) === sessionId) approvalRefs.push({ state: 'live' });
    }

    const tools = streamId ? asArray(state.toolCallsByStream?.get?.(streamId)) : [];
    const now = typeof source.now === 'function' ? source.now() : Date.now();
    // A manual compaction runs outside any turn but plays the same compact state.
    const sessionTyped = state.streamWaits?.getSessionTypedActivity?.(sessionId) || null;
    return {
      turnLive: LIVE_LIFECYCLES.has(lifecycle) || streamLive || Boolean(sessionTyped),
      admissionWait: userIndex >= 0 && !streamLive
        ? findAdmissionWait(sendController, sessionId, asObject(messages[userIndex])) : null,
      stoppedWithoutTerminal,
      outcome: token(target.outcome),
      approvalRefs,
      questionPending,
      typed: (streamId && state.streamWaits?.getTypedActivity?.(streamId)) || sessionTyped,
      runningTools: tools.map((tool) => {
        const ranAt = Number(asObject(tool).ranAt) || 0;
        return {
          status: normalizeStatus(asObject(tool).status),
          verb: token(toolUtils?.toolRunVerb?.(asObject(tool).toolName)),
          toolName: token(asObject(tool).toolName),
          justRan: ranAt > 0 && now - ranAt >= 0 && now - ranAt < JUST_RAN_MS,
        };
      }),
      deltaKind: streamId ? str(state.streamDeltaKindByStream?.get?.(streamId)) : '',
    };
  }

  function hasRenderableAssistantContent(message) {
    const kind = String(message?.kind || '').trim();
    if (String(message?.role || '').trim() !== 'assistant' || SPRITE_NON_CONTENT_KINDS.has(kind)) {
      return false;
    }
    return Boolean(
      String(message?.content || '').trim()
      || (
        Array.isArray(message?.reasoning?.entries)
        && message.reasoning.entries.length
      )
    );
  }

  function resolveAssistantSpriteAnchor(messages, latestAssistantMessageId, idToIndex) {
    const latestAssistantId = String(latestAssistantMessageId || '').trim();
    if (!latestAssistantId) {
      return { message: null, hasCurrentTurnAssistant: false, fallbacks: [] };
    }
    const indexedAssistantPosition = idToIndex?.has?.(latestAssistantId)
      ? Number(idToIndex.get(latestAssistantId))
      : -1;
    const latestAssistantPosition = Number.isInteger(indexedAssistantPosition)
      && indexedAssistantPosition >= 0
      ? indexedAssistantPosition
      : messages.findIndex((message) => String(message?.id || '').trim() === latestAssistantId);
    if (latestAssistantPosition < 0) {
      return { message: null, hasCurrentTurnAssistant: false, fallbacks: [] };
    }

    let latestUserPosition = -1;
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      if (String(messages[index]?.role || '').trim() === 'user') {
        latestUserPosition = index;
        break;
      }
    }
    const latestAssistantMessage = messages[latestAssistantPosition] || null;
    const hasCurrentTurnAssistant = latestAssistantPosition > latestUserPosition;
    if (!hasCurrentTurnAssistant) {
      return { message: latestAssistantMessage, hasCurrentTurnAssistant: false, fallbacks: [] };
    }

    // Tool-loop plumbing may become the newest assistant message even though
    // its visual rows belong to the same active turn. Keep the rail sprite on
    // the newest prose/reasoning anchor in that turn instead of bouncing to
    // the prompt or between transient tool rows. A tool-only first phase still
    // anchors to its assistant article until prose exists.
    for (let index = latestAssistantPosition; index > latestUserPosition; index -= 1) {
      if (hasRenderableAssistantContent(messages[index])) {
        return { message: messages[index], hasCurrentTurnAssistant: true, fallbacks: [] };
      }
    }
    // No prose yet. The newest assistant message is often the blank segment the
    // stream opens after each tool boundary, which the projector renders no node
    // for: the turn's earlier tool rows, newest first, stand in until it fills.
    const fallbacks = [];
    for (let index = latestAssistantPosition - 1; index > latestUserPosition; index -= 1) {
      if (String(messages[index]?.role || '').trim() === 'assistant') fallbacks.push(messages[index]);
    }
    return { message: latestAssistantMessage, hasCurrentTurnAssistant: true, fallbacks };
  }

  // The activity for a pane whose rail cannot show it (split view, IDE dock, phone width, an unmounted
  // row). The anchor comes from messages alone, so the jump control can still animate.
  function deriveDetachedSpriteActivity(source) {
    const { tracker, gatherDeps, sessionId, messages, assistantAnchor, latestAssistantId, streamId, normalizePhase, turnKey } = source;
    const anchor = assistantAnchor.message;
    const latest = assistantAnchor.hasCurrentTurnAssistant
      ? messages.find((message) => message?.id === latestAssistantId) : null;
    const outcomeMessage = latest || anchor;
    const input = gatherSpriteActivityInput(gatherDeps, sessionId, {
      messages,
      streamId: token(streamId) || token(anchor?.streamId),
      status: anchor?.status,
      outcome: outcomeMessage ? normalizePhase(outcomeMessage) : '',
    });
    return { activity: tracker.derive(input, { turnKey, visible: true }).activity, runningTools: input.runningTools };
  }

  function findDot(host) {
    return host ? [...host.children].find((child) => child.classList.contains('chat-sprite-dot')) || null : null;
  }

  function cssLoops(dot) {
    if (typeof dot?.getAnimations !== 'function') return [];
    return dot.getAnimations({ subtree: true }).filter((animation) => animation.animationName);
  }

  function loopKey(animation) {
    const target = animation.effect?.target;
    return `${animation.animationName}|${target?.parentElement?.className}|${target?.className}`;
  }

  // Both dots run the same CSS loops; sharing a start time makes them one animation.
  function copyLoopPhase(sourceDot, mirrorDot) {
    const source = new Map(cssLoops(sourceDot).map((animation) => [loopKey(animation), animation]));
    for (const loop of cssLoops(mirrorDot)) {
      const match = source.get(loopKey(loop));
      if (match?.playState === 'running' && loop.playState === 'running'
        && match.startTime != null && loop.startTime !== match.startTime) {
        loop.startTime = match.startTime;
      }
    }
  }

  // The jump control's copy of the rail sprite: a second morph engine told the same thing in the same
  // task, phase-locked to the rail, and suspended while the control is hidden.
  function createSpritePillMirror({ button, railHost, createMorph, MutationObserverRef, onShow }) {
    if (!button || typeof createMorph !== 'function') return null;
    let disposed = false;
    let shown = null;
    let alignRun = 0;

    function align() {
      if (disposed || !shown) return;
      const railDot = findDot(railHost);
      const pillDot = findDot(button);
      const loops = [...cssLoops(railDot), ...cssLoops(pillDot)];
      if (!loops.length) return;
      alignRun += 1;
      const run = alignRun;
      const copy = () => { if (run === alignRun && !disposed) copyLoopPhase(railDot, pillDot); };
      Promise.all(loops.map((loop) => loop.ready)).then(copy, copy);
    }

    const morph = createMorph(button, { onLoopsReleased: align });
    const isShowing = () => button.dataset.visible === 'true';

    function syncVisibility() {
      if (shown === isShowing()) return;
      shown = isShowing();
      if (!shown) {
        morph.suspend();
        return;
      }
      morph.resume();
      // A suspended engine skips form holds, so it can come back a step off the rail. With no
      // live rail the pipeline re-derives the form instead: anything remembered here is stale.
      const railDot = findDot(railHost);
      if (railDot && !railDot.hasAttribute('data-suspended')) morph.setActivity(railDot.getAttribute('data-activity'));
      onShow?.();
      align();
    }

    const observer = typeof MutationObserverRef === 'function' ? new MutationObserverRef(syncVisibility) : null;
    observer?.observe(button, { attributes: true, attributeFilter: ['data-visible'] });
    syncVisibility();

    return {
      align,
      isShowing,
      setActivity: morph.setActivity,
      reset: morph.reset,
      dispose() {
        if (disposed) return;
        disposed = true;
        observer?.disconnect();
        morph.dispose();
      },
    };
  }

  function createSpriteViewApplier({
    chatSpriteLayer,
    chatAssistantSprite,
    spriteRuntime,
    normalizeSpritePhase,
    morph = null,
    isDisposed,
    onHidden,
  }) {
    function createHiddenSpriteState({ clearTarget = false, reason = 'hidden' } = {}) {
      return {
        visible: false,
        targetMessageId: clearTarget ? '' : String(spriteRuntime.targetMessageId || ''),
        targetY: Math.round(Number(spriteRuntime.targetY || 0)),
        status: '',
        phase: 'hidden',
        suppressionReason: String(reason || 'hidden'),
        spriteActivity: '',
      };
    }

    function createVisibleSpriteState(targetMessage, targetY, spriteActivity = '') {
      return {
        visible: true,
        targetMessageId: String(targetMessage?.id || ''),
        targetY: Math.round(Math.max(Number(targetY) || 0, 0)),
        status: String(targetMessage?.status || ''),
        phase: normalizeSpritePhase(targetMessage),
        suppressionReason: '',
        spriteActivity,
      };
    }

    function sameSpriteState(left, right) {
      return Boolean(
        left
        && right
        && left.visible === right.visible
        && left.targetMessageId === right.targetMessageId
        && left.targetY === right.targetY
        && left.status === right.status
        && left.phase === right.phase
        && left.suppressionReason === right.suppressionReason
        && left.spriteActivity === right.spriteActivity
      );
    }

    function applySpriteViewState(nextState) {
      if (isDisposed() || !chatSpriteLayer || !chatAssistantSprite || !nextState) {
        return false;
      }
      const previousState = spriteRuntime.viewState || null;
      if (sameSpriteState(previousState, nextState)) {
        return false;
      }

      spriteRuntime.viewState = { ...nextState };
      spriteRuntime.targetMessageId = nextState.targetMessageId;
      spriteRuntime.targetY = nextState.targetY;

      if (!nextState.visible) {
        chatSpriteLayer.classList.remove('visible');
        chatSpriteLayer.dataset.suppressionReason = nextState.suppressionReason;
        chatAssistantSprite.classList.remove('is-streaming');
        chatAssistantSprite.dataset.status = '';
        chatAssistantSprite.dataset.spriteState = 'hidden';
        delete chatAssistantSprite.dataset.spriteActivity;
        // The layer overflows visibly inside the scroller, so an invisible
        // sprite still parked at its last row would keep that scroll height.
        chatAssistantSprite.style.transform = '';
        morph?.suspend();
        // A new session never inherits the old one's done or live form.
        if (nextState.suppressionReason === 'session_changed') morph?.reset();
        onHidden(nextState.suppressionReason);
        return true;
      }

      chatAssistantSprite.style.transform = `translate3d(0, ${nextState.targetY}px, 0)`;
      chatAssistantSprite.classList.toggle('is-streaming', nextState.phase === 'live');
      chatAssistantSprite.dataset.status = nextState.status;
      chatAssistantSprite.dataset.spriteState = nextState.phase;
      chatAssistantSprite.dataset.spriteActivity = nextState.spriteActivity;
      delete chatSpriteLayer.dataset.suppressionReason;
      chatSpriteLayer.classList.add('visible');
      if (previousState?.visible !== true) morph?.resume();
      morph?.setActivity(nextState.spriteActivity);
      return true;
    }

    return { createHiddenSpriteState, createVisibleSpriteState, applySpriteViewState };
  }

  return {
    deriveSpriteActivity,
    createSpriteActivityTracker,
    gatherSpriteActivityInput,
    findPaneAdmissionWait,
    createSpriteViewApplier,
    createSpritePillMirror,
    deriveDetachedSpriteActivity,
    hasRenderableAssistantContent,
    resolveAssistantSpriteAnchor,
    SPRITE_ACTIVITIES,
    SPRITE_NON_CONTENT_KINDS,
    JUST_RAN_MS,
  };
});
