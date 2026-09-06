/* renderer/chat/renderer-stream-buffer-utils.js -- semantic pre-session stream buffering (UMD) */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererStreamBufferUtils = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const STATUS_TYPES = new Set(['thinking_status', 'agent_status']);

  function utf8ByteLength(value) {
    const text = String(value || '');
    if (typeof TextEncoder === 'function') {
      return new TextEncoder().encode(text).byteLength;
    }
    if (typeof Buffer !== 'undefined' && typeof Buffer.byteLength === 'function') {
      return Buffer.byteLength(text, 'utf8');
    }
    return unescape(encodeURIComponent(text)).length;
  }

  function streamEventByteSize(payload) {
    try {
      return utf8ByteLength(JSON.stringify(payload));
    } catch (_error) {
      return 0;
    }
  }

  function statusKey(payload) {
    const type = String(payload?.type || '');
    if (!STATUS_TYPES.has(type)) return '';
    const identity = payload?.taskId
      || payload?.requestId
      || payload?.thinkingId
      || payload?.source
      || 'default';
    return `${type}:${String(identity)}`;
  }

  function canMergeDelta(previous, next) {
    if (previous?.type !== 'delta' || next?.type !== 'delta') return false;
    if (previous?.reasoning || next?.reasoning) return false;
    const previousMessageId = String(previous?.messageId || previous?.message_id || '');
    const nextMessageId = String(next?.messageId || next?.message_id || '');
    return !previousMessageId || !nextMessageId || previousMessageId === nextMessageId;
  }

  function stampEvent(payload, now) {
    const stamped = {
      ...payload,
      _bufferedAt: now,
    };
    stamped._bufferedByteSize = streamEventByteSize(stamped);
    return stamped;
  }

  function appendSemanticStreamEvent(events, payload, now = Date.now()) {
    const queue = Array.isArray(events) ? events : [];
    const type = String(payload?.type || '');
    if (type === 'started') {
      if (queue.some((event) => event?.type === 'started')) return queue;
      queue.push(stampEvent(payload, now));
      return queue;
    }

    const lastIndex = queue.length - 1;
    const previous = queue[lastIndex];
    if (canMergeDelta(previous, payload)) {
      const merged = {
        ...previous,
        ...payload,
        content: `${String(previous.content || '')}${String(payload.content || '')}`,
        _bufferedAt: now,
      };
      if (!Object.prototype.hasOwnProperty.call(payload, 'aggregate')) {
        delete merged.aggregate;
      }
      merged._bufferedByteSize = streamEventByteSize(merged);
      queue[lastIndex] = merged;
      return queue;
    }

    const key = statusKey(payload);
    if (key) {
      let existingIndex = -1;
      for (let index = queue.length - 1; index >= 0; index -= 1) {
        if (queue[index]?.type === 'stream_reset') break;
        if (statusKey(queue[index]) === key) {
          existingIndex = index;
          break;
        }
      }
      if (existingIndex !== -1) {
        queue[existingIndex] = stampEvent(payload, now);
        return queue;
      }
    }

    queue.push(stampEvent(payload, now));
    return queue;
  }

  function measureStreamEventBytes(events) {
    return (Array.isArray(events) ? events : []).reduce(
      (total, event) => total + (Number(event?._bufferedByteSize) || streamEventByteSize(event)),
      0
    );
  }

  function createDegradedStreamRecovery(options = {}) {
    const {
      getPersistedSession,
      setSessionMessages,
      setSessionTurnEventState,
      setSessionComposerNotice,
      queueSessionRender,
      appendClientLog,
    } = options;

    function guardedMutate(callOptions, mutation) {
      const guard = callOptions?.continuationGuard;
      if (guard && typeof guard.mutate === 'function') return guard.mutate(mutation);
      if (guard && typeof guard.isCurrent === 'function' && guard.isCurrent() !== true) return false;
      mutation();
      return true;
    }

    return async function recoverDegradedStream(payload, callOptions = {}) {
      const sessionId = String(payload?.sessionId || '').trim();
      const streamId = String(payload?.streamId || '').trim();
      appendClientLog?.('WARN', 'stream.buffer_replay_degraded', {
        sessionId: sessionId.slice(0, 30),
        streamId: streamId.slice(0, 30),
        reason: String(payload?.reason || 'buffer_cap').slice(0, 40),
        droppedEvents: Number(payload?.droppedEvents) || 0,
        droppedBytes: Number(payload?.droppedBytes) || 0,
      });
      guardedMutate(callOptions, () => {
        setSessionComposerNotice?.(sessionId, 'Some live updates were skipped. Resyncing this chat…');
      });
      try {
        const persisted = await getPersistedSession?.(sessionId);
        if (!persisted || callOptions?.signal?.aborted === true) {
          throw new Error('session hydration unavailable');
        }
        const committed = guardedMutate(callOptions, () => {
          setSessionMessages?.(sessionId, Array.isArray(persisted.data) ? persisted.data : [], `session_${sessionId}`);
          setSessionTurnEventState?.(sessionId, {
            turnEventLogVersion: Number(persisted.turn_event_log_version || 0),
            turnEvents: Array.isArray(persisted.turn_events) ? persisted.turn_events : [],
            activeTurn: persisted.active_turn ?? null,
          });
          setSessionComposerNotice?.(sessionId, 'Live updates were resynced after local buffering reached its safety limit.');
          queueSessionRender?.(sessionId, { messages: true, chrome: true });
        });
        return { buffered: false, terminal: false, degraded: true, hydrated: committed === true };
      } catch (error) {
        appendClientLog?.('WARN', 'stream.buffer_replay_hydration_failed', {
          sessionId: sessionId.slice(0, 30),
          streamId: streamId.slice(0, 30),
          message: String(error?.message || error).slice(0, 200),
        });
        guardedMutate(callOptions, () => {
          setSessionComposerNotice?.(sessionId, 'Live updates were interrupted. Reopen this chat to resync.');
        });
        return { buffered: false, terminal: false, degraded: true, hydrated: false };
      }
    };
  }

  return {
    appendSemanticStreamEvent,
    createDegradedStreamRecovery,
    measureStreamEventBytes,
    streamEventByteSize,
    utf8ByteLength,
  };
});
