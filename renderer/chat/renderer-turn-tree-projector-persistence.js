/* renderer/chat/renderer-turn-tree-projector-persistence.js
 * Pure factory owning persisted turn-event hydration. It receives its
 * normalization, construction, sorting, and phase helpers through dependency
 * injection.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererTurnTreeProjectorPersistence = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function createTurnTreePersistence(deps) {
    const {
      normalizeId,
      deepCloneJsonValue,
      sortKeyCompare,
      EVENT_KIND_PRIORITY,
      SUPPORTED_TURN_EVENT_LOG_VERSION,
      createTurn,
      pushDistinct,
      assignAssistantPhases,
      normalizeRole,
      normalizeKind,
      resolveBranchId,
      extractMessageStreamId,
      buildTurnTreeFromMessages,
    } = deps || {};

    if (typeof normalizeId !== 'function'
        || typeof createTurn !== 'function'
        || typeof pushDistinct !== 'function'
        || typeof assignAssistantPhases !== 'function'
        || typeof resolveBranchId !== 'function') {
      throw new Error('renderer-turn-tree-projector-persistence: required deps missing');
    }

    function isTurnEventLogSupported(value) {
      const version = Number(value);
      return Number.isInteger(version) && version >= 1 && version <= SUPPORTED_TURN_EVENT_LOG_VERSION;
    }

    function buildTurnTreeFromPersistedEvents(payload, threadTree) {
      const rawEvents = Array.isArray(payload.turn_events || payload.turnEvents)
        ? (payload.turn_events || payload.turnEvents)
        : [];
      const messages = Array.isArray(payload.messages) ? payload.messages : [];
      const messageById = new Map();
      const messageIndexById = new Map();
      for (let index = 0; index < messages.length; index += 1) {
        const message = messages[index];
        const messageId = normalizeId(message && message.id);
        if (messageId && !messageById.has(messageId)) {
          messageById.set(messageId, message);
          messageIndexById.set(messageId, index);
        }
      }
      const normalizedEvents = [];
      const intraOrderByEventId = new Map();
      const groupedEventSeqByMessageId = new Map();
      for (let index = 0; index < rawEvents.length; index += 1) {
        const sourceEvent = rawEvents[index];
        if (!sourceEvent || typeof sourceEvent !== 'object' || Array.isArray(sourceEvent)) {
          continue;
        }
        const turnId = normalizeId(sourceEvent && (sourceEvent.turn_id || sourceEvent.turnId));
        const kind = normalizeId(sourceEvent && sourceEvent.kind);
        if (!turnId || !kind) {
          continue;
        }
        const primaryMessageId = normalizeId(sourceEvent.primary_message_id || sourceEvent.primaryMessageId);
        const sourceMessageIds = Array.from(new Set(
          (Array.isArray(sourceEvent.source_message_ids || sourceEvent.sourceMessageIds)
            ? (sourceEvent.source_message_ids || sourceEvent.sourceMessageIds)
            : [sourceEvent.primary_message_id || sourceEvent.primaryMessageId]
          )
            .map((value) => normalizeId(value))
            .filter(Boolean)
        ));
        const anchorMessageId = primaryMessageId || sourceMessageIds.find((messageId) => messageIndexById.has(messageId)) || '';
        const eventSeq = Number(sourceEvent && sourceEvent.event_seq);
        const normalizedEvent = {
          sourceEvent,
          index,
          turnId,
          kind,
          primaryMessageId,
          sourceMessageIds,
          anchorMessageId,
          eventSeq: Number.isInteger(eventSeq) && eventSeq >= 0 ? eventSeq : index,
        };
        normalizedEvents.push(normalizedEvent);
        if (anchorMessageId) {
          const bucket = groupedEventSeqByMessageId.get(anchorMessageId) || [];
          bucket.push(normalizedEvent);
          groupedEventSeqByMessageId.set(anchorMessageId, bucket);
        }
      }
      for (const bucket of groupedEventSeqByMessageId.values()) {
        bucket.sort((left, right) => {
          const delta = left.eventSeq - right.eventSeq;
          if (delta !== 0) {
            return delta;
          }
          return left.index - right.index;
        });
        for (let position = 0; position < bucket.length; position += 1) {
          const eventId = normalizeId(bucket[position].sourceEvent?.event_id || bucket[position].sourceEvent?.eventId)
            || `${bucket[position].turnId}:${bucket[position].kind}:${bucket[position].index}`;
          intraOrderByEventId.set(eventId, position);
        }
      }
      const turnById = Object.create(null);
      const byMessageId = Object.create(null);
      const turns = [];

      function ensureTurn(turnId, eventSeq) {
        const normalizedTurnId = normalizeId(turnId);
        if (!turnById[normalizedTurnId]) {
          const turn = createTurn(normalizedTurnId, Number.isInteger(eventSeq) ? eventSeq : turns.length);
          turnById[normalizedTurnId] = turn;
          turns.push(turn);
        }
        return turnById[normalizedTurnId];
      }

      for (let index = 0; index < normalizedEvents.length; index += 1) {
        const normalizedSourceEvent = normalizedEvents[index];
        const sourceEvent = normalizedSourceEvent.sourceEvent;
        const turnId = normalizedSourceEvent.turnId;
        const kind = normalizedSourceEvent.kind;
        const eventSeq = normalizedSourceEvent.eventSeq;
        const turn = ensureTurn(turnId, eventSeq);
        let payloadValue = {};
        if (sourceEvent.payload && typeof sourceEvent.payload === 'object' && !Array.isArray(sourceEvent.payload)) {
          try { payloadValue = deepCloneJsonValue(sourceEvent.payload); } catch (_error) { payloadValue = {}; }
        }
        const eventId = normalizeId(sourceEvent.event_id || sourceEvent.eventId) || `${turnId}:${kind}:${index}`;
        const anchorMessageId = normalizedSourceEvent.anchorMessageId;
        const messageIndex = messageIndexById.has(anchorMessageId)
          ? Number(messageIndexById.get(anchorMessageId))
          : eventSeq;
        const intraMessageOrder = intraOrderByEventId.has(eventId)
          ? Number(intraOrderByEventId.get(eventId))
          : 0;
        const event = {
          event_id: eventId,
          event_seq: eventSeq,
          turn_id: turnId,
          kind,
          primary_message_id: normalizedSourceEvent.primaryMessageId,
          source_message_ids: normalizedSourceEvent.sourceMessageIds,
          sort_key: [
            messageIndex,
            intraMessageOrder,
            Number(EVENT_KIND_PRIORITY[kind]) || 0,
          ],
          payload: payloadValue,
        };
        if (sourceEvent.phase_id || sourceEvent.phaseId) {
          event.phase_id = normalizeId(sourceEvent.phase_id || sourceEvent.phaseId);
        }
        if (sourceEvent.tool_call_id || sourceEvent.toolCallId) {
          event.tool_call_id = normalizeId(sourceEvent.tool_call_id || sourceEvent.toolCallId);
        }
        if (sourceEvent.status) {
          event.status = normalizeId(sourceEvent.status);
        }
        if (payloadValue.assistant_phase) {
          event.assistant_phase = normalizeId(payloadValue.assistant_phase);
        }
        if (payloadValue.segment_group_index != null) {
          event.segment_group_index = Number(payloadValue.segment_group_index);
        }
        turn.events.push(event);
        pushDistinct(turn.source_message_ids, turn._sourceMessageIdSet, event.primary_message_id);
        for (const sourceMessageId of event.source_message_ids) {
          pushDistinct(turn.source_message_ids, turn._sourceMessageIdSet, sourceMessageId);
          byMessageId[sourceMessageId] = turn.turn_id;
        }
        if (!turn.primary_user_message_id && kind === 'user_prompt') {
          turn.primary_user_message_id = event.primary_message_id;
        }
        if (
          !turn.primary_assistant_message_id
          && kind !== 'user_prompt'
          && kind !== 'attachment_cluster'
          && kind !== 'interactive_recap'
          && kind !== 'slash_output'
        ) {
          turn.primary_assistant_message_id = event.primary_message_id;
        }
      }

      turns.sort((left, right) => {
        const leftSeq = Number(left?.events?.[0]?.event_seq || left?._firstMessageIndex || 0);
        const rightSeq = Number(right?.events?.[0]?.event_seq || right?._firstMessageIndex || 0);
        return leftSeq - rightSeq;
      });

      for (const turn of turns) {
        turn.events.sort((left, right) => sortKeyCompare(left.sort_key, right.sort_key));
        assignAssistantPhases(turn);
        if (!turn.primary_assistant_message_id) {
          for (const messageId of turn.source_message_ids) {
            const message = messageById.get(messageId);
            const role = normalizeRole(message);
            const kind = normalizeKind(message);
            if (role === 'assistant' && kind !== 'interactive_round_recap' && kind !== 'slash_command_output') {
              turn.primary_assistant_message_id = messageId;
              break;
            }
          }
        }
        turn.branch_id = resolveBranchId(
          threadTree,
          [
            turn.primary_assistant_message_id,
            turn.primary_user_message_id,
            ...turn.source_message_ids,
          ]
        );
        delete turn._sourceMessageIdSet;
        delete turn._kindOrdinalByName;
        delete turn._firstMessageIndex;
        delete turn._hasAssistantLikeMessage;
      }

      claimUnreferencedMessages(messages, threadTree, turns, turnById, byMessageId);

      return {
        turns,
        byTurnId: turnById,
        byMessageId,
      };
    }

    // A blank plain assistant segment carries nothing a reader could lose:
    // no kind, no content, no attachments, no reasoning entries. (Mirrored by
    // the rollout-signal exemption in renderer-render-pipeline-article-markup.js
    // — keep the two predicates in sync.)
    function isBlankAssistantSegmentMessage(message) {
      if (normalizeRole(message) !== 'assistant' || normalizeKind(message)) {
        return false;
      }
      if (String(message && message.content || '').trim()) {
        return false;
      }
      if (Array.isArray(message?.attachments) && message.attachments.length > 0) {
        return false;
      }
      const reasoningEntries = message?.reasoning?.entries;
      return !(Array.isArray(reasoningEntries) && reasoningEntries.length > 0);
    }

    // A contentless assistant segment whose EVERY reasoning entry id already
    // appears in one of the covered turn's persisted reasoning_phase events
    // carries nothing a reader could lose either: the recorder mis-retargeted
    // its phases onto a sibling segment (the pre-2026-07-06 reasoning-dup
    // shape fossilized in old sessions). Left unclaimed, such a message
    // flip-flops between a standalone legacy article (event-derived
    // projection) and a compat anchor (message-derived projection) on
    // alternating renders — a visible history blink while another turn
    // streams — and duplicates reasoning the turn article already shows.
    // A reasoning entry the event log does NOT hold keeps the message
    // unclaimed so the legacy fallback + rollout canary still surface
    // genuine store damage.
    function isEventCoveredReasoningOnlySegment(message, turn) {
      if (String(message?.kind || '').trim()) {
        return false;
      }
      if (String(message?.content || '').trim()) {
        return false;
      }
      if (Array.isArray(message?.attachments) && message.attachments.length > 0) {
        return false;
      }
      const entries = message?.reasoning?.entries;
      if (!Array.isArray(entries) || !entries.length) {
        return false;
      }
      const coveredEntryIds = new Set();
      for (const event of (Array.isArray(turn?.events) ? turn.events : [])) {
        if (normalizeId(event && event.kind) !== 'reasoning_phase') {
          continue;
        }
        const eventEntries = event?.payload?.entries;
        if (!Array.isArray(eventEntries)) {
          continue;
        }
        for (const entry of eventEntries) {
          const entryId = normalizeId(entry && entry.id);
          if (entryId) {
            coveredEntryIds.add(entryId);
          }
        }
      }
      if (!coveredEntryIds.size) {
        return false;
      }
      return entries.every((entry) => coveredEntryIds.has(normalizeId(entry && entry.id)));
    }

    // Hybrid claim pass (Ht-F canary fix). The persisted event log is the
    // exclusive turn-tree source once a session has any events, so messages
    // the log does not reference would otherwise fall to the legacy
    // per-message article path on every render. Two benign shapes are claimed
    // here; everything else stays unclaimed so the legacy fallback + its
    // rollout canary keep covering genuine store damage (a content-bearing
    // message the event log lost — the 2026-07-02 fingerprint):
    //  1. A blank assistant segment of an event-covered turn (the stream
    //     handler's pre-tool _seg0 that never got text or reasoning) joins its
    //     turn membership-only — it compat-anchors instead of rendering an
    //     empty legacy article.
    //  2. Messages of a stream with NO event-covered turn (a live turn whose
    //     events have not persisted yet) group through the message-derived
    //     builder, matching fresh-session rendering during streaming.
    function claimUnreferencedMessages(messages, threadTree, turns, turnById, byMessageId) {
      if (typeof extractMessageStreamId !== 'function') {
        return;
      }
      const uncoveredStreamMessages = [];
      for (let index = 0; index < messages.length; index += 1) {
        const message = messages[index];
        const messageId = normalizeId(message && message.id);
        if (!messageId || byMessageId[messageId]) {
          continue;
        }
        const streamId = extractMessageStreamId(message);
        if (!streamId) {
          continue;
        }
        const coveredTurn = turnById[streamId];
        if (coveredTurn) {
          if (
            isBlankAssistantSegmentMessage(message)
            || isEventCoveredReasoningOnlySegment(message, coveredTurn)
          ) {
            if (!coveredTurn.source_message_ids.includes(messageId)) {
              coveredTurn.source_message_ids.push(messageId);
            }
            byMessageId[messageId] = coveredTurn.turn_id;
          }
          continue;
        }
        uncoveredStreamMessages.push(message);
      }
      if (!uncoveredStreamMessages.length || typeof buildTurnTreeFromMessages !== 'function') {
        return;
      }
      const liveTree = buildTurnTreeFromMessages(uncoveredStreamMessages, threadTree);
      const liveTurns = Array.isArray(liveTree && liveTree.turns) ? liveTree.turns : [];
      for (const liveTurn of liveTurns) {
        const liveTurnId = normalizeId(liveTurn && liveTurn.turn_id);
        if (!liveTurnId || turnById[liveTurnId]) {
          continue;
        }
        turnById[liveTurnId] = liveTurn;
        turns.push(liveTurn);
      }
      const liveByMessageId = liveTree && liveTree.byMessageId && typeof liveTree.byMessageId === 'object'
        ? liveTree.byMessageId
        : {};
      for (const liveMessageId of Object.keys(liveByMessageId)) {
        const liveTurnId = normalizeId(liveByMessageId[liveMessageId]);
        if (!byMessageId[liveMessageId] && liveTurnId && turnById[liveTurnId]) {
          byMessageId[liveMessageId] = liveTurnId;
        }
      }
    }

    return {
      isTurnEventLogSupported,
      buildTurnTreeFromPersistedEvents,
    };
  }

  return { createTurnTreePersistence };
});
