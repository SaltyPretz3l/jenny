(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererSpriteActivity = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const SPRITE_ACTIVITIES = Object.freeze([
    'think', 'write', 'compose', 'check', 'search', 'tool', 'compact',
    'wait', 'stuck', 'approve', 'done', 'rest', 'stopped', 'error',
  ]);

  const SEARCH_VERBS = new Set(['read', 'list', 'search', 'web', 'fetch']);
  const EXECUTING_STATUSES = new Set(['running', 'executing']);
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

  function lastExecutingTool(runningTools) {
    const tools = asArray(runningTools);
    for (let index = tools.length - 1; index >= 0; index -= 1) {
      const tool = asObject(tools[index]);
      if (EXECUTING_STATUSES.has(str(tool.status))) return tool;
    }
    return null;
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
    if (tool) return result(SEARCH_VERBS.has(str(tool.verb)) ? 'search' : 'tool', true);

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
    return {
      turnLive: LIVE_LIFECYCLES.has(lifecycle) || streamLive,
      admissionWait: userIndex >= 0 && !streamLive
        ? findAdmissionWait(sendController, sessionId, asObject(messages[userIndex])) : null,
      stoppedWithoutTerminal,
      outcome: token(target.outcome),
      approvalRefs,
      questionPending,
      typed: (streamId && state.streamWaits?.getTypedActivity?.(streamId)) || null,
      runningTools: tools.map((tool) => ({
        status: normalizeStatus(asObject(tool).status),
        verb: token(toolUtils?.toolRunVerb?.(asObject(tool).toolName)),
      })),
      deltaKind: streamId ? str(state.streamDeltaKindByStream?.get?.(streamId)) : '',
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
        onHidden();
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
    SPRITE_ACTIVITIES,
  };
});
