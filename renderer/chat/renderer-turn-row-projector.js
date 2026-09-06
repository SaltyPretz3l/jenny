(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(
      require('./renderer-turn-row-projector-utils'),
      require('./renderer-turn-row-projector-tools'),
      require('./renderer-row-identity-utils'),
      require('./tool-call-utils'),
      require('../features/renderer-plan-document')
    );
    return;
  }
  root.rendererTurnRowProjector = factory(
    root.rendererTurnRowProjectorUtils,
    root.rendererTurnRowProjectorTools,
    root.rendererRowIdentityUtils || {},
    root.toolCallUtils || {},
    root.rendererPlanDocument || {}
  );
})(typeof globalThis !== 'undefined' ? globalThis : this, function (projectorUtils, toolRowFactory, rowIdentityUtils, toolCallUtils, planDocumentUtils) {
  'use strict';

  const {
    normalizeId,
    cloneSortKey,
    traceEventCompare,
    pushDistinct,
    normalizeGeneratedArtifact,
    normalizeToolLifecycleStatus,
    clonePlainObject,
  } = projectorUtils || {};

  // DC1 flicker cure: the projector stamps the SAME deterministic identity-tuple
  // row_id as the live reducer (one shared definition) so a hydrated row and its
  // live/reconciled counterpart share a DOM data-row-id. The array form also
  // disambiguates in-turn collisions the projector can produce that the reducer
  // (which merges by phase_id/call_id) cannot — e.g. a reused-phase reasoning
  // block split around a tool call. No-op / byte-identical when the flag is off.
  const stampDeterministicRowIds = rowIdentityUtils && typeof rowIdentityUtils.stampDeterministicRowIds === 'function'
    ? rowIdentityUtils.stampDeterministicRowIds
    : (rows) => rows;

  const TOOL_RELATED_KINDS = new Set([
    'tool_use',
    'tool_executing',
    'tool_result',
    'approval_requested',
    'user_questions_requested',
    'approval_resolved',
  ]);

  const DIRECT_RENDER_OWNER_ROW_KINDS = new Set([
    'user_bubble',
    'assistant_text',
    'tool_step',
    'tool_call',
    'tool_result',
    'approval_gap',
    'system_notice',
    'agent_progress',
    'batch',
    'recap',
    'suggestion',
    'slash_output',
    'attachment',
    'plan_object',
    'plan_document',
    'plan_proposal',
  ]);

  const SIMPLE_ROW_KIND_BY_EVENT = Object.freeze({
    interactive_batch: 'batch',
    interactive_recap: 'recap',
    proactive_suggestion: 'suggestion',
    slash_output: 'slash_output',
    attachment_cluster: 'attachment',
    plan_object: 'plan_object',
    plan_document: 'plan_document',
    plan_proposal: 'plan_proposal',
  });

  function createBaseRow(kind, turnId, sourceEvents, primaryMessageId) {
    const events = (Array.isArray(sourceEvents) ? sourceEvents : []).filter(Boolean);
    const firstEvent = events[0] || {};
    const row = {
      row_id: `row:${normalizeId(firstEvent.event_id)}`,
      turn_id: normalizeId(turnId),
      kind,
      primary_message_id: normalizeId(primaryMessageId || firstEvent.primary_message_id),
      render_message_id: '',
      source_message_ids: [],
      first_event_sort_key: cloneSortKey(firstEvent.sort_key),
      source_events: events.map((event) => normalizeId(event.event_id)).filter(Boolean),
      payload: {},
    };
    for (const event of events) {
      const ids = Array.isArray(event.source_message_ids) ? event.source_message_ids : [];
      for (const id of ids) {
        pushDistinct(row.source_message_ids, id);
      }
      if (!row.primary_message_id) {
        row.primary_message_id = normalizeId(event.primary_message_id);
      }
    }
    if (!row.source_message_ids.length && row.primary_message_id) {
      row.source_message_ids.push(row.primary_message_id);
    }
    return row;
  }

  function getDirectRenderMessageId(row) {
    if (!row || typeof row !== 'object') {
      return '';
    }
    const kind = normalizeId(row.kind);
    if (!DIRECT_RENDER_OWNER_ROW_KINDS.has(kind)) {
      return '';
    }
    return normalizeId(row.primary_message_id);
  }

  function assignRenderMessageIds(rows) {
    const sourceRows = Array.isArray(rows) ? rows : [];
    const directOwners = sourceRows.map((row) => getDirectRenderMessageId(row));
    const nextOwners = new Array(sourceRows.length);
    let nextOwner = '';
    for (let index = sourceRows.length - 1; index >= 0; index -= 1) {
      nextOwners[index] = nextOwner;
      if (directOwners[index]) {
        nextOwner = directOwners[index];
      }
    }
    let previousOwner = '';
    for (let index = 0; index < sourceRows.length; index += 1) {
      const row = sourceRows[index];
      if (!row || typeof row !== 'object') {
        continue;
      }
      const directOwner = directOwners[index];
      if (directOwner) {
        row.render_message_id = directOwner;
        previousOwner = directOwner;
        continue;
      }
      row.render_message_id = nextOwners[index] || previousOwner || normalizeId(row.primary_message_id);
    }
    return sourceRows;
  }

  function mergeReasoningEntries(existingEntries, incomingEntries) {
    const merged = (Array.isArray(existingEntries) ? existingEntries : []).map((entry) => ({ ...entry }));
    const indexById = new Map();
    for (let index = 0; index < merged.length; index += 1) {
      const id = normalizeId(merged[index] && merged[index].id);
      if (id && !indexById.has(id)) {
        indexById.set(id, index);
      }
    }
    const incoming = Array.isArray(incomingEntries) ? incomingEntries : [];
    for (const entry of incoming) {
      const cloned = { ...entry };
      const id = normalizeId(cloned && cloned.id);
      if (id && indexById.has(id)) {
        merged[indexById.get(id)] = cloned;
        continue;
      }
      if (id) {
        indexById.set(id, merged.length);
      }
      merged.push(cloned);
    }
    return merged;
  }

  function buildReasoningRow(turnId, events) {
    const row = createBaseRow('reasoning', turnId, events);
    const payload = {
      phase_id: '',
      thinking_id: '',
      tool_call_id: '',
      tool_name: '',
      render_collapsed: false,
      entries: [],
      chunk_count: 0,
    };
    let chunkCount = 0;
    let completed = false;
    for (const event of events) {
      payload.phase_id = payload.phase_id || normalizeId(event.phase_id || event.payload && event.payload.phase_id);
      payload.thinking_id = payload.thinking_id || normalizeId(event.payload && event.payload.thinking_id);
      payload.tool_call_id = payload.tool_call_id || normalizeId(event.tool_call_id || event.payload && event.payload.tool_call_id);
      payload.tool_name = payload.tool_name || normalizeId(event.payload && event.payload.tool_name);
      const eventSummary = String(event.payload && event.payload.summary || '').trim();
      if (eventSummary && !payload.summary) {
        payload.summary = eventSummary;
      }
      payload.render_collapsed = payload.render_collapsed || Boolean(event.payload && event.payload.render_collapsed);
      const entries = Array.isArray(event.payload && event.payload.entries) ? event.payload.entries : [];
      payload.entries = mergeReasoningEntries(payload.entries, entries);
      const eventChunkCount = Number(event.payload && event.payload.chunk_count);
      if (Number.isFinite(eventChunkCount) && eventChunkCount > 0) {
        chunkCount += eventChunkCount;
      }
      const status = normalizeId(event.status).toLowerCase();
      completed = completed
        || status === 'completed'
        || status === 'complete'
        || event.payload?.completed === true;
      // Timing (Ollama "Thought for Xs"): earliest start, latest completion.
      // Added only when present so legacy/empty-timing logs keep today's payload
      // shape and the replay corpus stays byte-identical.
      const eventStartedAt = normalizeId(
        event.started_at || event.startedAt
        || (event.payload && (event.payload.started_at || event.payload.startedAt))
      );
      if (eventStartedAt && !payload.started_at) {
        payload.started_at = eventStartedAt;
      }
      const eventCompletedAt = normalizeId(
        event.completed_at || event.completedAt
        || (event.payload && (event.payload.completed_at || event.payload.completedAt))
      );
      if (eventCompletedAt) {
        payload.completed_at = eventCompletedAt;
      }
    }
    payload.chunk_count = chunkCount || payload.entries.length;
    if (completed) {
      payload.completed = true;
    }
    row.phase_id = payload.phase_id;
    row.payload = payload;
    return row;
  }

  function buildAgentProgressRow(turnId, events) {
    const row = createBaseRow('agent_progress', turnId, events);
    const steps = [];
    for (const event of (Array.isArray(events) ? events : [])) {
      const eventSteps = Array.isArray(event && event.payload && event.payload.steps) ? event.payload.steps : [];
      for (const step of eventSteps) {
        if (step != null) steps.push(step);
      }
    }
    row.payload = { steps };
    return row;
  }

  function buildAssistantTextRow(turnId, events, groupIndex) {
    const row = createBaseRow('assistant_text', turnId, events);
    const payload = {
      assistant_phase: '',
      text: '',
      segments: [],
      segment_group_index: Number(groupIndex) || 0,
    };
    for (const event of events) {
      payload.assistant_phase = payload.assistant_phase || normalizeId(event.assistant_phase);
      const segment = event.payload && typeof event.payload === 'object' ? event.payload : {};
      payload.text += String(segment.text || '');
      payload.segments.push({
        segment_id: normalizeId(segment.segment_id),
        phase_id: normalizeId(segment.phase_id),
        text: String(segment.text || ''),
        message_index: Number(segment.message_index) || 0,
        segment_index: Number(segment.segment_index) || 0,
      });
    }
    row.assistant_phase = payload.assistant_phase;
    row.segment_group_index = payload.segment_group_index;
    row.payload = payload;
    return row;
  }

  // C4b: tool-cluster row builders are owned by a sibling factory so the
  // main projector stays under the modularity cap. The sibling is a pure
  // factory — it threads `createBaseRow` and the projector-utils helpers
  // through closure, no module-scope state.
  const {
    buildToolCallRow,
    buildApprovalGapRow,
    buildToolResultRow,
  } = (toolRowFactory && typeof toolRowFactory.createTurnRowProjectorTools === 'function'
    ? toolRowFactory.createTurnRowProjectorTools({
        createBaseRow,
        normalizeId,
        normalizeGeneratedArtifact,
         normalizeToolLifecycleStatus,
         clonePlainObject,
         statusForToolResult: toolCallUtils && toolCallUtils.statusForToolResult,
       })
    : {});

  // The trace tool-cluster builders (buildToolCallRow / buildApprovalGapRow /
  // buildToolResultRow) live in renderer-turn-row-projector-tools.js. The
  // legacy compact `buildToolStepRow` was retired with the compact projector.
  if (typeof buildToolCallRow !== 'function') {
    throw new Error('renderer-turn-row-projector: tool-row factory wire-up failed');
  }


  function buildSystemNoticeRow(turnId, events, subkind) {
    const row = createBaseRow('system_notice', turnId, events);
    const firstEvent = events[0] || {};
    row.payload = {
      subkind: normalizeId(subkind || firstEvent.payload && firstEvent.payload.subkind || firstEvent.kind),
      ...(
        firstEvent.payload && typeof firstEvent.payload === 'object' && !Array.isArray(firstEvent.payload)
          ? firstEvent.payload
          : {}
      ),
    };
    return row;
  }

  function buildSimpleRow(turnId, rowKind, events) {
    const row = createBaseRow(rowKind, turnId, events);
    row.payload = events[0] && events[0].payload && typeof events[0].payload === 'object'
      ? { ...events[0].payload }
      : {};
    return row;
  }

  function buildPlanDocumentRow(turnId, events) {
    const row = createBaseRow('plan_document', turnId, events);
    const projection = planDocumentUtils.coalesceTransitions(events);
    row.payload = { ...projection.document, transitions: projection.transitions };
    return row;
  }

  // Single O(N) pass bucketing tool-related events by normalized tool_call_id,
  // shared by the compact and trace projectors so each tool cluster looks up its
  // events instead of re-scanning the whole event list per cluster — turning the
  // O(tools x events) tool grouping into O(events) (findings #10, #11). Indices
  // reference the caller's already-sorted `events` array.
  function buildToolEventIndicesByCallId(events) {
    const indicesByCallId = new Map();
    for (let index = 0; index < events.length; index += 1) {
      const event = events[index];
      if (!event || !TOOL_RELATED_KINDS.has(event.kind)) {
        continue;
      }
      const callId = normalizeId(event.tool_call_id);
      // A blank correlation id is not an identity. Keep the event as an
      // independent/orphaned row instead of merging every malformed tool event
      // in the turn into one lifecycle bucket.
      if (!callId) {
        continue;
      }
      const bucket = indicesByCallId.get(callId);
      if (bucket) {
        bucket.push(index);
      } else {
        indicesByCallId.set(callId, [index]);
      }
    }
    return indicesByCallId;
  }

  function projectTurnRows(turnEvents, options) {
    const deterministicRowId = Boolean(options && options.deterministicRowId === true);
    const events = Array.isArray(turnEvents) ? turnEvents.slice().sort(traceEventCompare) : [];
    const turnId = normalizeId(events[0] && events[0].turn_id);
    const toolEventIndicesByCallId = buildToolEventIndicesByCallId(events);
    const pendingPlanDocumentCallIds = new Set(events
      .filter((event) => event && event.kind === 'plan_document'
        && normalizeId(event.status || event.payload && event.payload.transition) === 'pending')
      .map((event) => normalizeId(event.tool_call_id))
      .filter(Boolean));
    const rows = [];
    const processedIndices = new Set();
    let assistantSegmentGroupIndex = 0;

    for (let index = 0; index < events.length; index += 1) {
      if (processedIndices.has(index)) {
        continue;
      }
      const event = events[index];
      if (!event || !event.kind) {
        continue;
      }

      if (event.kind === 'user_prompt') {
        const sourceEvents = [event];
        processedIndices.add(index);
        for (let inner = index + 1; inner < events.length; inner += 1) {
          const next = events[inner];
          if (!next || processedIndices.has(inner)) {
            continue;
          }
          if (next.kind !== 'attachment_cluster' || normalizeId(next.primary_message_id) !== normalizeId(event.primary_message_id)) {
            break;
          }
          processedIndices.add(inner);
          sourceEvents.push(next);
        }
        const row = createBaseRow('user_bubble', turnId, sourceEvents, event.primary_message_id);
        row.payload = {
          content: String(event.payload && event.payload.content || ''),
          attachments: sourceEvents
            .filter((candidate) => candidate.kind === 'attachment_cluster')
            .flatMap((candidate) => Array.isArray(candidate.payload && candidate.payload.attachments) ? candidate.payload.attachments : []),
        };
        rows.push(row);
        continue;
      }

      if (event.kind === 'plan_document') {
        const planId = normalizeId(event.payload && event.payload.plan_id);
        const sourceEvents = [];
        for (let inner = index; inner < events.length; inner += 1) {
          const candidate = events[inner];
          if (!candidate || processedIndices.has(inner) || candidate.kind !== 'plan_document') continue;
          if (normalizeId(candidate.payload && candidate.payload.plan_id) !== planId) continue;
          processedIndices.add(inner);
          sourceEvents.push(candidate);
        }
        rows.push(buildPlanDocumentRow(turnId, sourceEvents));
        continue;
      }

      if (event.kind === 'reasoning_phase') {
        const sourceEvents = [event];
        processedIndices.add(index);
        for (let inner = index + 1; inner < events.length; inner += 1) {
          const next = events[inner];
          if (!next || processedIndices.has(inner)) {
            continue;
          }
          if (next.kind !== 'reasoning_phase' || normalizeId(next.phase_id) !== normalizeId(event.phase_id)) {
            break;
          }
          processedIndices.add(inner);
          sourceEvents.push(next);
        }
        rows.push(buildReasoningRow(turnId, sourceEvents));
        continue;
      }

      if (event.kind === 'assistant_text_segment') {
        const sourceEvents = [event];
        processedIndices.add(index);
        for (let inner = index + 1; inner < events.length; inner += 1) {
          const next = events[inner];
          if (!next || processedIndices.has(inner)) {
            continue;
          }
          if (next.kind !== 'assistant_text_segment') {
            break;
          }
          if (normalizeId(next.primary_message_id) !== normalizeId(event.primary_message_id)) {
            break;
          }
          if (normalizeId(next.assistant_phase) !== normalizeId(event.assistant_phase)) {
            break;
          }
          processedIndices.add(inner);
          sourceEvents.push(next);
        }
        rows.push(buildAssistantTextRow(turnId, sourceEvents, assistantSegmentGroupIndex));
        assistantSegmentGroupIndex += 1;
        continue;
      }

      if (event.kind === 'agent_progress') {
        processedIndices.add(index);
        const steps = Array.isArray(event.payload && event.payload.steps) ? event.payload.steps : [];
        if (steps.length) {
          rows.push(buildAgentProgressRow(turnId, [event]));
        }
        continue;
      }

      if (event.kind === 'tool_use') {
        const toolCallId = normalizeId(event.tool_call_id);
        const sourceEvents = [event];
        processedIndices.add(index);
        const approvalRequestEvents = [];
        let hasApprovalResolution = false;
        let hasToolResult = false;
        let resultEvent = null;
        // Missing ids fail closed as independent calls. Valid ids retain the
        // O(N) bucketed lookup without cross-call ambiguity.
        const bucketIndices = toolCallId ? (toolEventIndicesByCallId.get(toolCallId) || []) : [];
        for (let bucketIndex = 0; bucketIndex < bucketIndices.length; bucketIndex += 1) {
          const inner = bucketIndices[bucketIndex];
          const next = events[inner];
          if (!next || processedIndices.has(inner)) {
            continue;
          }
          if (next.kind === 'approval_requested' || next.kind === 'user_questions_requested'
            || next.kind === 'approval_resolved' || next.kind === 'tool_executing') {
            processedIndices.add(inner);
            if (next.kind === 'approval_requested') {
              // Source-event ownership is decided after the loop: when an
              // approval_gap row is emitted it OWNS its approval_requested
              // events, so they must NOT also land on the tool_call row (that
              // would double-count the event across two rows). They fall back
              // onto the tool_call row only when no gap row is emitted (e.g. a
              // resolved call whose canonical stream still carries the request).
              approvalRequestEvents.push(next);
            } else {
              sourceEvents.push(next);
              if (next.kind === 'approval_resolved') {
                hasApprovalResolution = true;
              }
            }
            continue;
          }
          if (next.kind === 'tool_result') {
            hasToolResult = true;
            // Capture (but do not consume) the result so buildToolCallRow can
            // reconcile to a terminal state. The result still emits its own
            // tool_result row below, preserving trace granularity.
            if (!resultEvent) {
              resultEvent = next;
            }
          }
        }
        const emitApprovalGapRow = approvalRequestEvents.length > 0 && !hasApprovalResolution && !hasToolResult;
        if (!emitApprovalGapRow) {
          // No gap row to own them — the tool_call row claims the request events
          // so every turn event still maps back to exactly one row.
          for (let requestIndex = 0; requestIndex < approvalRequestEvents.length; requestIndex += 1) {
            sourceEvents.push(approvalRequestEvents[requestIndex]);
          }
        }
        sourceEvents.sort((left, right) => traceEventCompare(left, right));
        rows.push(buildToolCallRow(turnId, sourceEvents, toolCallId, { resultEvent, awaitingApproval: emitApprovalGapRow }));
        if (emitApprovalGapRow) {
          const approvalGapRow = buildApprovalGapRow(turnId, approvalRequestEvents, toolCallId, { toolUseEvent: event });
          const approvalVariant = typeof toolCallUtils.deriveApprovalVariant === 'function'
            ? toolCallUtils.deriveApprovalVariant(
              event.payload && event.payload.tool_name,
              pendingPlanDocumentCallIds.has(toolCallId)
            )
            : '';
          if (approvalVariant) {
            approvalGapRow.payload.approval_variant = approvalVariant;
          }
          rows.push(approvalGapRow);
        }
        continue;
      }

      if (event.kind === 'tool_result') {
        processedIndices.add(index);
        rows.push(buildToolResultRow(turnId, event, normalizeId(event.tool_call_id)));
        continue;
      }

      if (event.kind === 'assistant_error' || event.kind === 'system_notice') {
        processedIndices.add(index);
        rows.push(buildSystemNoticeRow(turnId, [event]));
        continue;
      }

      if (event.kind === 'source_citations') {
        // Collector-derived web-search citations (flag `source_citations`).
        // Modeled on the context_compacted system-notice precedent; the refs
        // payload flows through for renderCitationChips. Lockstep with the
        // tree projector's kind-priority slot (AGENTS.md kind contract).
        processedIndices.add(index);
        rows.push(buildSystemNoticeRow(turnId, [event], 'source_citations'));
        continue;
      }

      if (SIMPLE_ROW_KIND_BY_EVENT[event.kind]) {
        processedIndices.add(index);
        rows.push(buildSimpleRow(turnId, SIMPLE_ROW_KIND_BY_EVENT[event.kind], [event]));
        continue;
      }

      if (TOOL_RELATED_KINDS.has(event.kind)) {
        processedIndices.add(index);
        rows.push(buildSystemNoticeRow(turnId, [event], `orphan_${event.kind}`));
        continue;
      }

      processedIndices.add(index);
      rows.push(buildSystemNoticeRow(turnId, [event], `unhandled_${event.kind}`));
    }

    // DC1 flicker cure: stamp the deterministic row_id after every builder has
    // assigned its tuple fields (phase_id/thinking_id, segment_group_index,
    // tool_call_id). A single post-pass mirrors the reducer's per-builder-tail
    // stamp with identical output for non-colliding rows, and additionally
    // disambiguates in-turn collisions (see stampDeterministicRowIds). Only the
    // five DC1 kinds change; every other kind keeps `row:${event_id}`, so
    // flag-off (and flag-on for those kinds) is byte-identical.
    // assignRenderMessageIds never reads row_id.
    if (deterministicRowId) {
      stampDeterministicRowIds(rows, true);
    }

    return assignRenderMessageIds(rows);
  }

  // Resolve the canonical turn view-model builder without introducing a hard
  // cycle. The builder is optional at load time — if the module is not
  // available (for example in a test environment that only pulls in the row
  // projector), projectTurn degrades gracefully to returning only rows.
  let cachedViewModelFactory = undefined;
  function resolveViewModelFactory() {
    if (cachedViewModelFactory !== undefined) {
      return cachedViewModelFactory;
    }
    const globalRef = typeof globalThis !== 'undefined' ? globalThis : {};
    if (globalRef.rendererTurnViewModel && typeof globalRef.rendererTurnViewModel.buildTurnViewModel === 'function') {
      cachedViewModelFactory = globalRef.rendererTurnViewModel.buildTurnViewModel;
      return cachedViewModelFactory;
    }
    try {
      const mod = require('./renderer-turn-view-model');
      cachedViewModelFactory = mod && typeof mod.buildTurnViewModel === 'function' ? mod.buildTurnViewModel : null;
      return cachedViewModelFactory;
    } catch (_error) {
      cachedViewModelFactory = null;
      return cachedViewModelFactory;
    }
  }

  // projectTurn is the Phase 2 composite entrypoint: it builds the canonical
  // turn view-model AND projects rows in a single pass, so consumers do not
  // need to co-evolve both derivations. Row shapes and IDs match what
  // projectTurnRows already returns, so existing fixtures and replay digests
  // keep working unchanged. Non-row semantic signals (raw terminal substatus,
  // phaseHint, canonical tool lifecycle) are carried by the view-model so
  // Phase 2D / later phases can migrate off the per-row payload fields
  // without re-walking events.
  function projectTurn(turn, options) {
    const opts = options || {};
    const events = Array.isArray(turn && turn.events) ? turn.events : [];
    const rows = projectTurnRows(events, { deterministicRowId: opts.deterministicRowId === true });
    const build = resolveViewModelFactory();
    let viewModel = null;
    if (typeof build === 'function') {
      viewModel = build(turn, {
        messageById: opts.messageById || null,
        toolMessageIdsByCallId: opts.toolMessageIdsByCallId || null,
      });
      applyViewModelEnrichments(rows, viewModel);
    }
    return { rows, viewModel };
  }

  function applyViewModelEnrichments(rows, viewModel) {
    if (!Array.isArray(rows) || !viewModel || !Array.isArray(viewModel.toolCalls)) {
      return;
    }
    const toolCallByCallId = new Map();
    for (const toolCall of viewModel.toolCalls) {
      const callId = normalizeId(toolCall && toolCall.toolCallId);
      if (callId) toolCallByCallId.set(callId, toolCall);
    }
    if (!toolCallByCallId.size) return;
    for (const row of rows) {
      if (!row || !row.payload) continue;
      const kind = row.kind;
      if (kind !== 'tool_step' && kind !== 'tool_call' && kind !== 'tool_result') continue;
      const callId = normalizeId(row.tool_call_id || (row.payload && row.payload.tool_call_id));
      if (!callId) continue;
      const canonical = toolCallByCallId.get(callId);
      if (!canonical) continue;
      // raw_terminal is a new field; never overwrite it if already present.
      const rawTerminal = normalizeId(canonical.rawTerminal);
      if (rawTerminal && !Object.prototype.hasOwnProperty.call(row.payload, 'raw_terminal')) {
        row.payload.raw_terminal = rawTerminal;
      }
      // Phase 2F state convergence for visible tool rows. The projector's
      // payload.state is known to be wrong in at least one real-world path:
      // when the tree projector stamps message-level status on lifecycle
      // events, the projector can land on 'abandoned' for a tool that the
      // view-model correctly classifies as 'cancelled' (preempted) or
      // 'timed_out' (timeout). The canonical view-model is the single
      // authority; overwrite the projector's state here so consumers of
      // projectTurn see one truth. projectTurnRows direct output is
      // untouched, so replay fixtures remain byte-stable.
      if (
        (kind === 'tool_step' || kind === 'tool_call') &&
        canonical.state &&
        canonical.state !== row.payload.state
      ) {
        row.payload.state = canonical.state;
      }
    }
  }

  return {
    projectTurnRows,
    projectTurn,
  };
});
