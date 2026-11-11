/* renderer/chat/renderer-follow-store.js - the write_file / edit_file calls the app follows while the model writes them (UMD) */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(
      require('./renderer-follow-argument-decoder'),
      require('./renderer-turn-normalization-utils'),
      require('./renderer-stream-activity-tail')
    );
    return;
  }
  root.rendererFollowStore = factory(
    root.rendererFollowArgumentDecoder || {},
    root.rendererTurnNormalizationUtils || {},
    root.rendererStreamActivityTail || {}
  );
})(typeof globalThis !== 'undefined' ? globalThis : this, function (argumentDecoder, turnNormalizationUtils, activityTail) {
  'use strict';

  /* One renderer-side store behind both views of a file arriving: the draft tab
     in the Workspace editor and the tail under the chat's activity row.
     renderer-stream-handler.js passes every stream event to noteStreamEvent;
     the store keeps one record per followed call and tells its listeners when
     a record changed. Pure logic: no DOM, no timers, no IPC. */

  const FOLLOWED_TOOLS = Object.freeze({ write_file: 'write', edit_file: 'edit' });
  const DEFAULT_MAX_ENDED = 8;
  const LIVE_PHASES = new Set(['arriving', 'waiting']);

  const { createFollowArgumentDecoder, DEFAULT_MAX_CHARS } = argumentDecoder;
  const extractToolCallId = turnNormalizationUtils.extractToolCallId
    || function (payload) { return text(payload && (payload.callId || payload.toolCallId)); };

  function text(value) {
    return typeof value === 'string' ? value.trim() : '';
  }

  function isPlainObject(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
  }

  function isFollowedTool(name) {
    return Object.prototype.hasOwnProperty.call(FOLLOWED_TOOLS, name);
  }

  function isLive(call) {
    return LIVE_PHASES.has(call.phase);
  }

  function firstString(...values) {
    for (const value of values) {
      if (typeof value === 'string') return value;
    }
    return '';
  }

  function entryFromInput(source) {
    const input = isPlainObject(source) ? source : {};
    return {
      oldText: firstString(input.old_string),
      oldDone: true,
      newText: firstString(input.new_string),
      newStarted: true,
      newDone: true,
      replaceAll: input.replace_all === true,
    };
  }

  function editsFromInput(input) {
    if (Array.isArray(input.edits)) return input.edits.map(entryFromInput);
    return [entryFromInput(input)];
  }

  function editsLength(edits) {
    let total = 0;
    for (const entry of edits) total += entry.oldText.length + entry.newText.length;
    return total;
  }

  function sameEdits(a, b) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i += 1) {
      const x = a[i];
      const y = b[i];
      if (x.oldText !== y.oldText || x.oldDone !== y.oldDone || x.newText !== y.newText
        || x.newStarted !== y.newStarted || x.newDone !== y.newDone || x.replaceAll !== y.replaceAll) return false;
    }
    return true;
  }

  // A tool event's `input` is the persisted snapshot: secret-shaped text is redacted and every
  // string is cut at 512 characters (services/backend/tool-loop-input-sanitization.js). Only an
  // approval small enough to be shown exactly (`exact_approval.sha256`) carries the real text.
  function hasExactInput(payload) {
    const exact = payload.exact_approval;
    return isPlainObject(payload.input) && isPlainObject(exact) && exact.too_large !== true
      && typeof exact.sha256 === 'string' && exact.sha256 !== '';
  }

  function createFollowStore(options) {
    const settings = isPlainObject(options) ? options : {};
    const isEnabled = typeof settings.isEnabled === 'function' ? settings.isEnabled : () => true;
    const getActiveSessionId = typeof settings.getActiveSessionId === 'function' ? settings.getActiveSessionId : () => '';
    const resolveSessionId = typeof settings.resolveSessionId === 'function'
      ? settings.resolveSessionId
      : (payload) => payload && payload.sessionId;
    const createDecoder = typeof settings.createDecoder === 'function' ? settings.createDecoder : createFollowArgumentDecoder;
    const maxChars = Number.isFinite(settings.maxChars) && settings.maxChars >= 0 ? settings.maxChars : DEFAULT_MAX_CHARS;
    const maxEnded = Number.isFinite(settings.maxEnded) && settings.maxEnded >= 0 ? Math.floor(settings.maxEnded) : DEFAULT_MAX_ENDED;

    const byId = new Map();        // call id or alias -> record
    const decoders = new Map();    // record -> decoder, only while the call can still be decoded
    let order = [];                // records, oldest first
    let ended = [];                // ended records, the one that ended first at the front
    let listeners = [];
    let pendingReveal = '';

    function safe(fn, fallback) {
      try {
        return fn();
      } catch (_error) {
        return fallback;
      }
    }

    function enabled() {
      return safe(() => !!isEnabled(), false);
    }

    function notify(event) {
      for (const listener of listeners.slice()) {
        safe(() => listener(event));
      }
    }

    function touch(call) {
      call.revision += 1;
      notify({ type: 'updated', call });
    }

    function sessionOf(payload) {
      return text(safe(() => resolveSessionId(payload), ''));
    }

    // ---- lookup and creation ----

    function find(callId) {
      return callId ? byId.get(callId) || null : null;
    }

    // The record an arriving event may write to. A provider can reuse a call id in a later
    // reply: an ended record of another stream gives way to the new call.
    function findCurrent(callId, payload) {
      const call = find(callId);
      const streamId = text(payload.streamId);
      if (!call || isLive(call) || !streamId || call.streamId === streamId) return call;
      releaseCall(call);
      return null;
    }

    function adoptable(streamId, toolName) {
      const matches = order.filter((call) => call.source === 'stream' && call.phase === 'arriving'
        && !call.authoritative && call.streamId === streamId && call.toolName === toolName);
      return matches.length === 1 ? matches[0] : null;
    }

    function create(payload, callId, toolName, source) {
      const sessionId = sessionOf(payload);
      if (!sessionId || sessionId !== text(safe(() => getActiveSessionId(), ''))) return null;
      const call = {
        callId,
        sessionId,
        streamId: text(payload.streamId),
        toolName,
        mode: FOLLOWED_TOOLS[toolName],
        source,
        phase: 'arriving',
        authoritative: false,
        tooLarge: false,
        bytes: 0,
        path: '',
        pathDone: false,
        content: '',
        contentStarted: false,
        contentDone: false,
        edits: [],
        revision: 0,
      };
      byId.set(callId, call);
      order.push(call);
      if (source === 'stream') decoders.set(call, createDecoder({ maxChars }));
      return call;
    }

    // The call a tool_use / tool_approval_needed event belongs to, made when it is new.
    function findOrCreate(payload, toolName) {
      const callId = extractToolCallId(payload);
      let call = findCurrent(callId, payload);
      if (call) return { call, created: false };
      if (callId) {
        call = adoptable(text(payload.streamId), toolName);
        if (call) {
          byId.set(callId, call);
          return { call, created: false };
        }
      }
      if (!callId) return { call: null, created: false };
      call = create(payload, callId, toolName, 'whole');
      return { call, created: !!call };
    }

    // ---- ending and releasing ----

    function forget(call) {
      for (const [id, record] of Array.from(byId)) {
        if (record === call) byId.delete(id);
      }
      decoders.delete(call);
      order = order.filter((record) => record !== call);
      ended = ended.filter((record) => record !== call);
      if (pendingReveal === call.callId) pendingReveal = '';
    }

    function releaseCall(call) {
      forget(call);
      notify({ type: 'removed', call });
    }

    function end(call, phase) {
      call.phase = phase;
      decoders.delete(call);
      ended.push(call);
      touch(call);
      while (ended.length > maxEnded) releaseCall(ended[0]);
    }

    // ---- applying data ----

    function applyDecoded(call, snapshot) {
      call.path = snapshot.path.trim();
      call.pathDone = snapshot.pathDone;
      if (call.mode === 'write') {
        call.content = snapshot.content;
        call.contentStarted = snapshot.contentStarted;
        call.contentDone = snapshot.contentDone;
      } else {
        call.edits = snapshot.edits;
      }
    }

    // Replaces the text with an exact input's; returns true when the record changed.
    function applyExactText(call, input) {
      let changed = false;
      const content = call.mode === 'write' ? firstString(input.content, input.file_content) : '';
      const edits = call.mode === 'edit' ? editsFromInput(input) : [];
      const length = call.mode === 'write' ? content.length : editsLength(edits);
      if (length > maxChars) {
        if (!call.tooLarge) changed = true;
        call.tooLarge = true;
      } else if (call.mode === 'write') {
        if (content !== call.content || !call.contentStarted) changed = true;
        call.content = content;
        call.contentStarted = true;
      } else {
        if (!sameEdits(edits, call.edits)) changed = true;
        call.edits = edits;
      }
      if (call.source === 'whole' && length !== call.bytes) {
        call.bytes = length;
        changed = true;
      }
      return changed;
    }

    // The arguments are complete: no fragment follows this event. An exact input replaces the
    // text. Any other input is cut and redacted, so the decoded text stands and a call that never
    // streamed has no text to show. Returns true when the record changed.
    function settleInput(call, payload) {
      if (!isPlainObject(payload.input)) return false;
      const exact = hasExactInput(payload);
      let changed = !call.authoritative;
      if (exact || !call.pathDone) {
        const path = text(firstString(payload.input.path, payload.input.file_path));
        if (path !== call.path || !call.pathDone) changed = true;
        call.path = path;
        call.pathDone = true;
      }
      if (exact) {
        if (applyExactText(call, payload.input)) changed = true;
      } else if (call.source === 'whole' && isPlainObject(payload.exact_approval) && !call.tooLarge) {
        call.tooLarge = true; // asked about, and too large to be shown exactly
        changed = true;
      }
      if (call.mode === 'write' && !call.contentDone && (exact || call.source === 'stream')) {
        call.contentDone = true;
        changed = true;
      }
      call.authoritative = true;
      decoders.delete(call);
      return changed;
    }

    // ---- events ----

    function onDelta(payload) {
      const toolName = text(payload.toolName);
      const callId = text(payload.toolCallId);
      if (!isFollowedTool(toolName) || !callId) return;
      let call = findCurrent(callId, payload);
      if (!call) {
        call = create(payload, callId, toolName, 'stream');
        if (!call) return;
      } else if (call.phase !== 'arriving' || call.authoritative) {
        return;
      }
      if (Number.isFinite(payload.argumentsBytes) && payload.argumentsBytes >= 0) call.bytes = payload.argumentsBytes;
      const decoder = decoders.get(call);
      if (decoder && !call.tooLarge) {
        if (typeof payload.argumentsDelta === 'string') decoder.push(payload.argumentsDelta);
        const snapshot = decoder.snapshot();
        applyDecoded(call, snapshot);
        if (call.bytes > maxChars || snapshot.overflow) call.tooLarge = true;
      }
      touch(call);
    }

    function onToolUse(payload) {
      const toolName = text(payload.toolName);
      if (!isFollowedTool(toolName)) return;
      const { call, created } = findOrCreate(payload, toolName);
      if (!call || !isLive(call)) return;
      const changed = settleInput(call, payload);
      if (created || changed) touch(call);
    }

    // `tool_approval_withdrawn` has no handler: a paused run keeps its approval pending, so the
    // call stays as it is until it is asked again, gets a result, or its stream ends.
    function onApprovalNeeded(payload) {
      const toolName = text(payload.toolName);
      if (!isFollowedTool(toolName)) return;
      const { call } = findOrCreate(payload, toolName);
      if (!call || !isLive(call)) return;
      settleInput(call, payload);
      call.phase = 'waiting';
      touch(call);
    }

    function onToolResult(payload) {
      const call = find(extractToolCallId(payload));
      if (!call || !isLive(call)) return;
      if (payload.approvalState === 'denied') end(call, 'denied');
      else if (payload.isError === true) end(call, 'failed');
      else end(call, 'written');
    }

    function liveCallsOfStream(payload) {
      const streamId = text(payload.streamId);
      return order.filter((call) => isLive(call) && call.streamId === streamId);
    }

    function onStreamEnd(payload) {
      for (const call of liveCallsOfStream(payload)) end(call, 'stopped');
    }

    function onStreamReset(payload) {
      for (const call of liveCallsOfStream(payload)) releaseCall(call);
    }

    const HANDLERS = {
      tool_input_delta: onDelta,
      tool_use: onToolUse,
      tool_approval_needed: onApprovalNeeded,
      tool_result: onToolResult,
      stream_reset: onStreamReset,
      complete: onStreamEnd,
      error: onStreamEnd,
    };

    function noteStreamEvent(payload) {
      try {
        if (!isPlainObject(payload) || !enabled()) return;
        const type = String(payload.type).trim().toLowerCase();
        if (!Object.prototype.hasOwnProperty.call(HANDLERS, type)) return;
        HANDLERS[type](payload);
      } catch (_error) {
        // A malformed event must never break the stream handler that feeds this.
      }
    }

    // ---- the public surface ----

    function subscribe(listener) {
      if (typeof listener !== 'function') return () => {};
      listeners.push(listener);
      return () => {
        listeners = listeners.filter((entry) => entry !== listener);
      };
    }

    function reset() {
      for (const call of order.slice()) releaseCall(call);
      pendingReveal = '';
    }

    function requestReveal(callId) {
      const call = find(text(callId));
      if (!call) return;
      pendingReveal = call.callId;
      notify({ type: 'reveal', call });
    }

    function takePendingReveal() {
      const callId = pendingReveal;
      pendingReveal = '';
      return callId;
    }

    return {
      noteStreamEvent,
      subscribe,
      getCall: (callId) => find(text(callId)),
      listCalls: () => order.slice(),
      requestReveal,
      takePendingReveal,
      refreshEnabled() {
        if (!enabled()) reset();
      },
      reset,
      dispose() {
        reset();
        listeners = [];
      },
    };
  }

  /* Stream-handler side: the one store, the chat's tail, and the hub the Workspace editor
     (built later, on demand) reads from globalThis.rendererFollowJennyHub. The switch lives
     in the IDE view state; until Workspace has been opened once it is read from the saved
     state on the first stream event, never at startup. */
  function createFollowWiring({ state, setActiveView, getChatTimeline, windowRef } = {}) {
    const win = windowRef || globalThis;
    let saved; // undefined: not asked yet; null: asked; then the saved switch as a boolean
    let store = null;

    function askSaved() {
      const api = win.jennyShell?.workspaceIde;
      if (typeof api?.getState !== 'function') return;
      Promise.resolve().then(() => api.getState()).then((persisted) => {
        saved = persisted?.followJenny !== false;
        store?.refreshEnabled();
      }).catch(() => {});
    }

    function switchOn() {
      const ide = state?.ui?.ide;
      if (ide && typeof ide === 'object') return ide.followJenny !== false;
      if (saved === undefined) {
        saved = null;
        askSaved();
      }
      return saved !== false;
    }

    store = createFollowStore({
      isEnabled: () => state?.features?.featureFlags?.follow_jenny === true && switchOn(),
      getActiveSessionId: () => state?.currentSessionId,
    });

    function timelineOf(call) {
      const target = win.rendererAppPaneComposition?.getPaneComposition?.()?.getSessionPaneTarget?.(call.sessionId);
      if (target?.chatTimeline) return target.chatTimeline;
      return typeof getChatTimeline === 'function' && call.sessionId === text(state?.currentSessionId) ? getChatTimeline() : null;
    }

    let tail = null;
    // The Watch link: a click always shows the file, wherever the user is.
    function watch(call) {
      store.requestReveal(call.callId);
      setActiveView?.('ide');
      tail?.sync();
    }
    if (typeof activityTail.createStreamActivityTail === 'function') {
      tail = activityTail.createStreamActivityTail({
        store,
        getTimeline: timelineOf,
        isWorkspaceActive: () => state?.ui?.activeView === 'ide',
        onWatch: watch,
        actionButton: (options) => win.inventoryActionButton?.(options) || '',
      });
    }

    const hub = {
      store,
      // Stops the reply that is writing: the same stop as the composer's.
      stop: (sessionId) => state?.runtimeSendController?.stopChat?.(sessionId),
    };
    win.rendererFollowJennyHub = hub;

    return {
      store,
      noteStreamEvent: store.noteStreamEvent,
      dispose() {
        tail?.dispose();
        store.dispose();
        if (win.rendererFollowJennyHub === hub) win.rendererFollowJennyHub = null;
      },
    };
  }

  return { createFollowStore, createFollowWiring, FOLLOWED_TOOLS };
});
