(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('../features/renderer-plan-document'));
    return;
  }
  root.rendererTurnReducerCanonicalRows = factory(root.rendererPlanDocument || {});
})(typeof globalThis !== 'undefined' ? globalThis : this, function (planDocumentUtils) {
  'use strict';

  const normalizePlanDocument = planDocumentUtils.normalizePlanDocument;
  if (typeof normalizePlanDocument !== 'function') {
    throw new Error('renderer-plan-document must load before renderer-turn-reducer-canonical-rows');
  }

  // Event kinds the hydrated projector turns into a row one-for-one, mirrored
  // from SIMPLE_ROW_KIND_BY_EVENT in renderer-turn-row-projector.js. Mirrored
  // rather than imported on purpose: the consolidation makes the projector
  // depend on this fold, not the other way round.
  //
  // plan_document stays absent because the shared live+replay branch below claims
  // it first and coalesces every event of a plan into ONE row.
  const SIMPLE_ROW_KIND_BY_EVENT = Object.freeze({
    interactive_batch: 'batch',
    interactive_recap: 'recap',
    proactive_suggestion: 'suggestion',
    slash_output: 'slash_output',
    attachment_cluster: 'attachment',
    plan_object: 'plan_object',
    plan_proposal: 'plan_proposal',
  });

  function createTurnCanonicalRowBuilders(context) {
    const {
      buildBaseRow,
      ensureRowEvent,
      stampRowIdentity,
      normalizeId,
      pushDistinct,
      deepCloneJsonValue,
      normalizeToolStatus,
      resolveTerminalPresentation,
    } = context;

    function applyCanonicalRowEvent(turn, event) {
      if (event.kind === 'plan_document') {
        const eventPlanId = normalizeId(event.payload && event.payload.plan_id);
        const eventToolCallId = normalizeId(event.tool_call_id);
        let row = null;
        let created = false;
        for (let index = 0; index < turn.rows.length; index += 1) {
          const candidate = turn.rows[index];
          if (!candidate || candidate.kind !== 'plan_document') continue;
          const candidatePayload = candidate.payload || {};
          if (eventPlanId
            ? normalizeId(candidatePayload.plan_id) === eventPlanId
            : normalizeId(candidatePayload.tool_call_id) === eventToolCallId) {
            row = candidate;
            break;
          }
        }
        if (!row) {
          row = buildBaseRow('plan_document', turn.turn_id, event);
          turn.rows.push(row);
          pushDistinct(turn.source_message_ids, row.primary_message_id);
          created = true;
        }
        // The live tool_result-derived transition event is keyed by call id
        // (the metadata carries no plan_id), so its message id can differ from
        // the row's plan_id-keyed one. Skip source-id attribution on that
        // mismatch — replay events always match, and parity with the replayed
        // row's source_message_ids is the contract.
        ensureRowEvent(row, event, {
          attributeSourceIds: normalizeId(event.primary_message_id) === row.primary_message_id,
        });
        const merged = {
          ...row.payload,
          ...deepCloneJsonValue(event.payload && typeof event.payload === 'object' ? event.payload : {}),
        };
        const transition = String(
          event.payload && event.payload.transition || event.status || event.state || ''
        ).trim().slice(0, 40).toLowerCase();
        const transitions = Array.isArray(row.payload && row.payload.transitions)
          ? row.payload.transitions.slice()
          : [];
        if (transition) transitions.push(transition);
        row.payload = { ...normalizePlanDocument(merged), transition, transitions };
        if (created) stampRowIdentity(turn, row);
        return true;
      }
      // The user's own turn-opening row. Only the hydrated side ever saw it: the
      // live stream normalizer emits no user_prompt event
      // (renderer-turn-reducer-stream-event-utils.js), so the live fold simply had
      // no branch for it and every replayed turn came out one row short of the
      // projector's. Consolidation runs hydration back through this fold, so the
      // row has to be built here.
      if (event.kind === 'user_prompt') {
        const row = buildBaseRow('user_bubble', turn.turn_id, event);
        row.payload = {
          content: String(event.payload && event.payload.content || ''),
          // Deliberately empty: the prompt event carries its own attachments copy,
          // but the hydrated projector fills the bubble from the adjacent
          // attachment_cluster events instead. Reading the same source keeps the
          // two folds byte-identical here rather than merely equivalent.
          attachments: [],
        };
        turn.rows.push(row);
        pushDistinct(turn.source_message_ids, row.primary_message_id);
        stampRowIdentity(turn, row);
        return true;
      }
      // Attachments arrive as a separate canonical event. The hydrated projector
      // folds the clusters ADJACENT to a user_prompt into that bubble and treats a
      // detached one as its own row; adjacency here is "the bubble is still the
      // newest row", which needs no lookahead and no pending-target bookkeeping.
      // A detached cluster stays unhandled, exactly as it is today -- the measured
      // fold gap records none, so building a row for it would be speculative.
      if (event.kind === 'attachment_cluster') {
        const bubble = turn.rows[turn.rows.length - 1];
        if (
          bubble
          && bubble.kind === 'user_bubble'
          && bubble.primary_message_id === normalizeId(event.primary_message_id)
        ) {
          ensureRowEvent(bubble, event);
          const attachments = Array.isArray(event.payload && event.payload.attachments)
            ? event.payload.attachments
            : [];
          for (let index = 0; index < attachments.length; index += 1) {
            bubble.payload.attachments.push(deepCloneJsonValue(attachments[index]));
          }
          return true;
        }
        // A detached cluster belongs to no bubble and becomes its own `attachment`
        // row instead -- it falls through to the simple-kind branch below, which is
        // where the projector's table sends it too.
      }

      // Progress from a sub-agent. The projector drops a stepless event rather than
      // rendering an empty row, and tests the RAW step list before filtering nulls;
      // both details are matched so the two folds agree on row count.
      if (event.kind === 'agent_progress') {
        const steps = Array.isArray(event.payload && event.payload.steps) ? event.payload.steps : [];
        if (steps.length) {
          const row = buildBaseRow('agent_progress', turn.turn_id, event);
          row.payload = { steps: steps.filter((step) => step != null).map((step) => deepCloneJsonValue(step)) };
          turn.rows.push(row);
          stampRowIdentity(turn, row);
        }
        return true;
      }
      // Three event kinds share one row kind, exactly as they do in the projector's
      // buildSystemNoticeRow. assistant_error is NOT the reducer's terminal `error`
      // kind handled above: that one stamps turn.status and creates no row, which is
      // why the rehydrate path remaps assistant_error onto it to avoid a duplicate
      // (REHYDRATE_KIND_REMAP, renderer-stream-rehydrate.js). Under canonical replay
      // the two arrive as distinct kinds and each does its own job.
      if (
        event.kind === 'system_notice'
        || event.kind === 'assistant_error'
        || event.kind === 'source_citations'
      ) {
        const body = event.payload && typeof event.payload === 'object' && !Array.isArray(event.payload)
          ? event.payload
          : {};
        const row = buildBaseRow('system_notice', turn.turn_id, event);
        row.payload = {
          subkind: normalizeId(
            event.kind === 'source_citations' ? 'source_citations' : (body.subkind || event.kind)
          ),
          ...deepCloneJsonValue(body),
        };
        turn.rows.push(row);
        stampRowIdentity(turn, row);
        // A persisted assistant_error IS the turn's terminal outcome (a stored
        // turn_failed/turn_cancelled), so it settles the turn as well as producing a
        // row. Without the stamp the turn sits at an empty status and the deck shows
        // a phantom "Writing"/"Thinking" forever.
        if (event.kind === 'assistant_error') {
          turn.status = resolveTerminalPresentation(event.terminal_status, { fallbackStatus: 'error' }).status;
        }
        return true;
      }
      if (SIMPLE_ROW_KIND_BY_EVENT[event.kind]) {
        const row = buildBaseRow(SIMPLE_ROW_KIND_BY_EVENT[event.kind], turn.turn_id, event);
        row.payload = event.payload && typeof event.payload === 'object' && !Array.isArray(event.payload)
          ? deepCloneJsonValue(event.payload)
          : {};
        turn.rows.push(row);
        stampRowIdentity(turn, row);
        return true;
      }
      return false;
    }

    // Seal a turn whose event log is COMPLETE. A tool left `running` after the last
    // event never got a result, which makes it interrupted -- but that verdict is
    // only available to something that knows no more events are coming, so the fold
    // cannot reach it while streaming and must be told.
    //
    // This is the honest home for a state the hydrated projector guesses. It derives
    // `interrupted` from the mere absence of a result, which is right after a reload
    // and WRONG for a turn still in flight, and the codebase pays for that guess
    // twice: guardLiveTurnRows in renderer-render-pipeline-hydration.js patches the
    // state back to `running` for live turns (with isTurnStreamLive's three-branch
    // liveness heuristic behind it), and pickBetterRow in
    // renderer-render-message-index-utils.js carries a special matchup rule letting a
    // live row beat a canonical `interrupted` one. A fold that only seals when the
    // log is complete is right by construction and needs neither.
    //
    // That same completeness signal makes sealing an unresolved approval safe here:
    // this runs only from terminal reconcile, after the sidecar can no longer be
    // waiting for an answer. The Wave 3a approval-precedence hazard (c80555b3) only
    // applies while a live turn could still be stranded by retracting its prompt.
    function sealTurnRows(turn) {
      const rows = turn && Array.isArray(turn.rows) ? turn.rows : [];
      for (let index = 0; index < rows.length; index += 1) {
        const row = rows[index];
        if (row && row.kind === 'plan_document' && row.payload && row.payload.state === 'pending') {
          row.payload.state = 'abandoned';
          row.payload.transition = 'abandoned';
          row.payload.transitions = [
            ...(Array.isArray(row.payload.transitions) ? row.payload.transitions : []),
            'abandoned',
          ];
          continue;
        }
        if (!row || row.kind !== 'tool_call' || !row.payload) {
          continue;
        }
        const status = normalizeToolStatus(row.payload.state);
        if (
          status === 'running'
          || status === 'awaiting_approval'
          || status === 'pending_approval'
        ) {
          row.payload.state = 'interrupted';
        }
      }
      return turn;
    }

    return { applyCanonicalRowEvent, sealTurnRows };
  }

  return { createTurnCanonicalRowBuilders };
});
