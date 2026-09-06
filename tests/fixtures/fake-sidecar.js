const API_VERSION = '2026-08-17';
const JSONRPC_VERSION = '2.0';
const {
  buildActiveModelCapabilities,
  buildActiveModelReasoningSupport,
  buildAvailableTools,
  buildProviderCapabilities,
  buildToolsStatus,
} = require('./fake-sidecar-capabilities');
const {
  buildMemoryContextLessons,
  buildMemorySuggestion,
  deleteMemory,
  listApprovedMemories,
  recallMemories,
  recallRecentMemories,
  saveMemory,
  updateMemory,
} = require('./fake-sidecar-memory');
const delayMs = Number(process.env.FAKE_BACKEND_DELAY_MS || 0);
const progressIntervalMs = Number(process.env.FAKE_BACKEND_PROGRESS_INTERVAL_MS || 0);
let progressTimer = null;
let started = false;
let approvalRequestId = 1000;
let buffer = Buffer.alloc(0);
const pendingApprovals = new Map();
const savedMemories = new Map();
const pendingMemories = new Map();
let nextMemoryId = 1;
let nextPendingMemoryId = 1;
let currentActiveEngine = 'mock';
let currentActiveModel = 'mock-v1';
let currentConfig = {};

process.stdout.on('error', (error) => {
  if (error && error.code === 'EPIPE') {
    process.exit(0);
  }
  throw error;
});

function buildFrame(message) {
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  const header = Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'utf8');
  return Buffer.concat([header, body]);
}

function writeMessage(message) {
  process.stdout.write(buildFrame(message));
}

function notification(method, params) {
  return {
    jsonrpc: JSONRPC_VERSION,
    api_version: API_VERSION,
    method,
    params: {
      ...params,
      api_version: API_VERSION,
    },
  };
}

function resultResponse(id, result) {
  return {
    jsonrpc: JSONRPC_VERSION,
    api_version: API_VERSION,
    id,
    result,
  };
}

function parseMessages() {
  while (true) {
    const headerIndex = buffer.indexOf('\r\n\r\n');
    if (headerIndex === -1) {
      return;
    }
    const header = buffer.slice(0, headerIndex).toString('utf8');
    const match = header.match(/Content-Length:\s*(\d+)/i);
    if (!match) {
      buffer = Buffer.alloc(0);
      return;
    }
    const contentLength = Number(match[1]);
    const bodyStart = headerIndex + 4;
    if (buffer.length < bodyStart + contentLength) {
      return;
    }
    const payload = JSON.parse(buffer.slice(bodyStart, bodyStart + contentLength).toString('utf8'));
    buffer = buffer.slice(bodyStart + contentLength);
    handleMessage(payload);
  }
}

function latestUserContent(params) {
  const messages = Array.isArray(params?.messages) ? params.messages : [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (String(message?.role || '').trim() !== 'user') {
      continue;
    }
    const content = String(message?.content || '').trim();
    if (content) {
      return content;
    }
  }
  return '';
}

function normalizeSpaces(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function buildPendingMemoryKey(sessionId, fingerprint) {
  return `${normalizeSpaces(sessionId)}::${normalizeSpaces(fingerprint).toLowerCase()}`;
}

function upsertPendingMemory(sessionId, candidate) {
  const normalizedSessionId = normalizeSpaces(sessionId);
  const fingerprint = normalizeSpaces(candidate?.content_fingerprint).toLowerCase();
  if (!normalizedSessionId || !fingerprint) {
    return null;
  }
  const now = new Date().toISOString();
  const key = buildPendingMemoryKey(normalizedSessionId, fingerprint);
  const existing = pendingMemories.get(key);
  const nextRecord = {
    id: existing?.id || nextPendingMemoryId++,
    session_id: normalizedSessionId,
    source_request_id: existing?.source_request_id || `request_${Date.now()}`,
    title: normalizeSpaces(candidate?.title || '').slice(0, 120),
    lesson_text: normalizeSpaces(candidate?.lesson_text || '').slice(0, 240),
    lesson_kind: normalizeSpaces(candidate?.lesson_kind || '').toLowerCase(),
    confidence: Math.max(0, Math.min(Number(candidate?.confidence || 0), 1)),
    source_excerpt: normalizeSpaces(candidate?.source_excerpt || '').slice(0, 240),
    content_fingerprint: fingerprint,
    family_key: normalizeSpaces(candidate?.family_key || '').toLowerCase(),
    category: normalizeSpaces(candidate?.category || 'suggested').toLowerCase() || 'suggested',
    created_at: existing?.created_at || now,
    updated_at: now,
  };
  pendingMemories.set(key, nextRecord);
  return nextRecord;
}

function listPendingMemories() {
  return Array.from(pendingMemories.values()).sort((left, right) => {
    const updatedCompare = String(right.updated_at || '').localeCompare(String(left.updated_at || ''));
    if (updatedCompare !== 0) {
      return updatedCompare;
    }
    return Number(right.id || 0) - Number(left.id || 0);
  });
}

function deletePendingMemoryRecord(sessionId, contentFingerprint) {
  const key = buildPendingMemoryKey(sessionId, contentFingerprint);
  if (!key || !pendingMemories.has(key)) {
    return false;
  }
  pendingMemories.delete(key);
  return true;
}

function buildInteractiveBatch(roundCount, questions) {
  return {
    object: 'jenny.interactive.question_batch',
    batch_id: `ib_${Math.max(Number(roundCount || 0), 0) + 1}`,
    round_index: Math.max(Number(roundCount || 0), 0) + 1,
    intro_text: 'A couple quick questions so I can help better.',
    questions,
  };
}

function sendChatCompletion(
  id,
  params,
  {
    withTool = false,
    requireApproval = false,
    forcedToolName = '',
    unavailableToolReason = '',
    mcpRetryMetadata = null,
  } = {}
) {
  const requestId = String(params.request_id || `req_${id}`);
  const sessionId = String(params.session_id || '');
  const content = latestUserContent(params);
  const attachments = Array.isArray(params?.attachments) ? params.attachments : [];
  const learningContextLessons = buildMemoryContextLessons(params, content, savedMemories);
  const interactiveResponse = params.interactive_response && typeof params.interactive_response === 'object'
    ? params.interactive_response
    : null;
  const interactiveRoundCount = Math.max(Number(params.interactive_round_count || 0), 0);
  // Unified conversation mode: question batches are content-invited ("ask me"),
  // mirroring the mock engine's planner trigger, not a conversation_mode param.
  const invitesQuestions = /\bask me\b/i.test(content);
  const planMode = params.plan_mode === true;
  const reasoningEffort = String(params.reasoning_effort || '').trim().toLowerCase();
  const phaseEventsEnabled = currentConfig?.feature_flags?.phase_events === true;
  let phaseSequence = 0;

  function emitPhase(method, phaseKind, extras = {}) {
    if (!phaseEventsEnabled) {
      return;
    }
    phaseSequence += 1;
    writeMessage(notification(method, {
      request_id: requestId,
      session_id: sessionId,
      trace_id: String(params.trace_id || requestId),
      phase_id: String(extras.phase_id || `phase_${phaseKind}_${requestId}_${phaseSequence}`),
      phase_kind: phaseKind,
      iteration: Number(extras.iteration || 1),
      ...(extras.thinking_id ? { thinking_id: extras.thinking_id } : {}),
      ...(extras.tool_call_id ? { tool_call_id: extras.tool_call_id } : {}),
      ...(extras.tool_name ? { tool_name: extras.tool_name } : {}),
    }));
  }

  if (invitesQuestions && !interactiveResponse) {
    const wantsDrift = /\bdrift\b/i.test(content);
    const wantsPlannerFallback = /\bplanner fallback\b/i.test(content);
    const wantsInvalidBatch = /\binvalid interactive batch\b/i.test(content);
    const wantsOversizedBatch = /\boversized interactive batch\b/i.test(content);
    if (wantsPlannerFallback || /\bpost-answer question batch\b/i.test(content)) {
      writeMessage(notification('chat.token', {
        request_id: requestId,
        session_id: sessionId,
        trace_id: String(params.trace_id || requestId),
        delta: wantsPlannerFallback ? 'Here is a direct answer after planner fallback.' : 'Here is a direct answer before follow-up questions.',
        role: 'assistant',
      }));
      writeMessage(notification('chat.done', {
        request_id: requestId,
        session_id: sessionId,
        trace_id: String(params.trace_id || requestId),
        usage: {
          input_tokens: 8,
          output_tokens: 6,
          total_tokens: 14,
          provider: 'mock',
          model: 'mock-v1',
          estimated: false,
        },
        stop_reason: 'end_turn',
        model: 'mock-v1',
        provider: 'mock',
      }));
      if (wantsPlannerFallback) {
        writeMessage(resultResponse(id, {
          request_id: requestId,
          status: 'completed',
        }));
        return;
      }
    }
    if (wantsDrift) {
      writeMessage(notification('chat.token', {
        request_id: requestId,
        session_id: sessionId,
        trace_id: String(params.trace_id || requestId),
        delta: 'What outcome matters most here?',
        role: 'assistant',
      }));
      writeMessage(notification('chat.done', {
        request_id: requestId,
        session_id: sessionId,
        trace_id: String(params.trace_id || requestId),
        usage: {
          input_tokens: 8,
          output_tokens: 4,
          total_tokens: 12,
          provider: 'mock',
          model: 'mock-v1',
          estimated: false,
        },
        stop_reason: 'end_turn',
        model: 'mock-v1',
        provider: 'mock',
      }));
      writeMessage(resultResponse(id, {
        request_id: requestId,
        status: 'completed',
      }));
      return;
    }
    if (wantsInvalidBatch) {
      writeMessage(notification('chat.question_batch', {
        request_id: requestId,
        session_id: sessionId,
        trace_id: String(params.trace_id || requestId),
        batch: {
          object: 'jenny.interactive.question_batch',
          batch_id: `ib_${interactiveRoundCount + 1}`,
          round_index: interactiveRoundCount + 1,
          intro_text: 'A couple quick questions so I can help better.',
          questions: [],
        },
      }));
      writeMessage(resultResponse(id, {
        request_id: requestId,
        status: 'question_batch',
      }));
      return;
    }
    if (wantsOversizedBatch) {
      writeMessage(notification('chat.question_batch', {
        request_id: requestId,
        session_id: sessionId,
        trace_id: String(params.trace_id || requestId),
        batch: buildInteractiveBatch(interactiveRoundCount, [
          { id: 'q1', prompt: 'Question 1?', options: [{ id: 'a1', label: 'Answer 1' }, { id: 'b1', label: 'Answer B1' }] },
          { id: 'q2', prompt: 'Question 2?', options: [{ id: 'a2', label: 'Answer 2' }, { id: 'b2', label: 'Answer B2' }] },
          { id: 'q3', prompt: 'Question 3?', options: [{ id: 'a3', label: 'Answer 3' }, { id: 'b3', label: 'Answer B3' }] },
          { id: 'q4', prompt: 'Question 4?', options: [{ id: 'a4', label: 'Answer 4' }, { id: 'b4', label: 'Answer B4' }] },
          { id: 'q5', prompt: 'Question 5?', options: [{ id: 'a5', label: 'Answer 5' }, { id: 'b5', label: 'Answer B5' }] },
          { id: 'q6', prompt: 'Question 6?', options: [{ id: 'a6', label: 'Answer 6' }, { id: 'b6', label: 'Answer B6' }] },
        ]),
      }));
      writeMessage(resultResponse(id, {
        request_id: requestId,
        status: 'question_batch',
      }));
      return;
    }

    const wantsMulti = /\bmulti\b/i.test(content);
    const batch = wantsMulti
      ? buildInteractiveBatch(interactiveRoundCount, [
          {
            id: 'q1',
            prompt: 'What kind of pace feels right?',
            options: [
              { id: 'steady', label: 'Steady' },
              { id: 'fast', label: 'Fast' },
            ],
          },
          {
            id: 'q2',
            prompt: 'What should I optimize for first?',
            options: [
              { id: 'clarity', label: 'Clarity' },
              { id: 'speed', label: 'Speed' },
              { id: 'other', label: 'Other' },
            ],
          },
          {
            id: 'q3',
            prompt: 'How hands-on should I be?',
            options: [
              { id: 'guided', label: 'Guided' },
              { id: 'collaborative', label: 'Collaborative' },
            ],
          },
        ])
      : buildInteractiveBatch(interactiveRoundCount, [
          {
            id: 'q1',
            prompt: 'What kind of pace feels right?',
            options: [
              { id: 'steady', label: 'Steady' },
              { id: 'fast', label: 'Fast' },
            ],
          },
        ]);

    writeMessage(notification('chat.question_batch', {
      request_id: requestId,
      session_id: sessionId,
      trace_id: String(params.trace_id || requestId),
      batch,
    }));
    writeMessage(resultResponse(id, {
      request_id: requestId,
      status: 'question_batch',
    }));
    return;
  }

  const normalizedMode = String(params.mode || '').trim().toLowerCase();
  const shouldEmitProviderReasoning =
    /^qwen3\.5(?::|$)/i.test(currentActiveModel)
    && (normalizedMode === 'assist' || normalizedMode === 'chat');

  if (shouldEmitProviderReasoning) {
    emitPhase('chat.phase_started', 'reasoning', {
      thinking_id: `think_${requestId}`,
      iteration: 1,
    });
    const reasoningDeltas = /\blong reasoning\b/i.test(content)
      ? [
          `<think>${'reasoning '.repeat(900)}</think>`,
          'tool_input={"path":"C:\\\\Users\\\\demo\\\\secret\\\\notes.txt","token":"abc123"}',
        ]
      : [
          'Checking the request intent.',
          'Forming a concise answer.',
        ];
    for (const delta of reasoningDeltas) {
      writeMessage(notification('chat.thinking', {
        request_id: requestId,
        session_id: sessionId,
        trace_id: String(params.trace_id || requestId),
        delta,
        thinking_id: `think_${requestId}`,
        kind: 'reasoning',
        persist: true,
      }));
    }
    emitPhase('chat.phase_completed', 'reasoning', {
      thinking_id: `think_${requestId}`,
      iteration: 1,
    });
  } else {
    writeMessage(notification('chat.thinking', {
      request_id: requestId,
      session_id: sessionId,
      trace_id: String(params.trace_id || requestId),
      delta: 'Thinking through the request.',
      thinking_id: `think_${requestId}`,
      kind: 'status',
      persist: false,
    }));
  }

  const emitTokens = () => {
    emitPhase('chat.phase_started', 'text', { iteration: 1 });
    if (unavailableToolReason) {
      writeMessage(notification('chat.token', {
        request_id: requestId,
        session_id: sessionId,
        trace_id: String(params.trace_id || requestId),
        delta: `web_search is unavailable for this request: ${unavailableToolReason}.`,
        role: 'assistant',
      }));
      emitPhase('chat.phase_completed', 'text', { iteration: 1 });
      writeMessage(notification('chat.done', {
        request_id: requestId,
        session_id: sessionId,
        trace_id: String(params.trace_id || requestId),
        usage: {
          input_tokens: 8,
          output_tokens: 6,
          total_tokens: 14,
          provider: 'mock',
          model: 'mock-v1',
          estimated: false,
        },
        stop_reason: 'end_turn',
        model: 'mock-v1',
        provider: 'mock',
      }));
      writeMessage(resultResponse(id, {
        request_id: requestId,
        status: 'completed',
      }));
      return;
    }
    const pieces = attachments.length
      ? ['Vision ', 'analysis ', 'complete']
      : interactiveResponse
        ? String(interactiveResponse.disposition || '').trim().toLowerCase() === 'skipped'
          ? ['I can keep going', ' with the context you already gave me.']
          : ['Thanks for clarifying', ' that helps a lot.']
        : ['Hello ', 'from ', 'the ', 'sidecar'];
    if (learningContextLessons.length) {
      pieces.push(' with ', 'learning ', 'context');
    }
    if (reasoningEffort) {
      pieces.push(' at ', reasoningEffort, ' effort');
    }
    for (const piece of pieces) {
      writeMessage(notification('chat.token', {
        request_id: requestId,
        session_id: sessionId,
        trace_id: String(params.trace_id || requestId),
        delta: piece,
        role: 'assistant',
      }));
    }
    emitPhase('chat.phase_completed', 'text', { iteration: 1 });
    writeMessage(notification('chat.done', {
      request_id: requestId,
      session_id: sessionId,
      trace_id: String(params.trace_id || requestId),
      usage: {
        input_tokens: 8,
        output_tokens: 4,
        total_tokens: 12,
        provider: 'mock',
        model: 'mock-v1',
        estimated: false,
      },
      stop_reason: 'end_turn',
      model: 'mock-v1',
      provider: 'mock',
    }));
    writeMessage(resultResponse(id, {
      request_id: requestId,
      status: 'completed',
    }));
  };

  if (!withTool) {
    if (currentConfig.tools_python_runtime_enabled === true && /\bpython\b/i.test(content)) {
      writeMessage(notification('tool.executing', {
        request_id: requestId,
        session_id: sessionId,
        trace_id: String(params.trace_id || requestId),
        tool_name: 'python_execute',
        tool_call_id: `${requestId}:python_execute:1`,
        tool_input: { code: 'print(2 + 2)' },
      }));
      writeMessage(notification('tool.result', {
        request_id: requestId,
        session_id: sessionId,
        trace_id: String(params.trace_id || requestId),
        tool_name: 'python_execute',
        tool_call_id: `${requestId}:python_execute:1`,
        tool_input: { code: 'print(2 + 2)' },
        success: true,
        output: JSON.stringify({
          stdout: '4',
          stderr: '',
          error: null,
          images: [],
          tables: [],
          last_expr_repr: null,
          truncated: false,
        }),
        content_type: 'text',
      }));
    }
    emitTokens();
    return;
  }

  const toolName = forcedToolName || (requireApproval ? 'write_file' : 'read_file');
  const toolCallId = `${requestId}:${toolName}:1`;
  const isMcpTool = toolName.startsWith('mcp__');
  const toolInput = requireApproval
    ? { path: 'notes.md', content: 'approved content' }
    : toolName === 'web_search'
      ? { query: content || 'current weather' }
      : isMcpTool
        ? { query: content || 'release notes' }
        : { path: 'notes.md' };
  const toolOutputPayload = toolName === 'web_search'
    ? {
        ok: true,
        query: toolInput.query,
        results: [
          {
            title: 'Nashville Weather',
            url: 'https://example.com/weather/nashville',
          },
        ],
      }
    : isMcpTool
      ? { ok: true, server_tool: toolName.split('__').slice(2).join('__') }
      : { ok: true, path: toolInput.path };

  const emitToolFlow = () => {
    emitPhase('chat.phase_started', 'tool_use', {
      iteration: 1,
      tool_call_id: toolCallId,
      tool_name: toolName,
    });
    writeMessage(notification('tool.executing', {
      request_id: requestId,
      session_id: sessionId,
      trace_id: String(params.trace_id || requestId),
      tool_name: toolName,
      tool_call_id: toolCallId,
      tool_input: toolInput,
    }));
    emitPhase('chat.phase_completed', 'tool_use', {
      iteration: 1,
      tool_call_id: toolCallId,
      tool_name: toolName,
    });
    emitPhase('chat.phase_started', 'tool_result', {
      iteration: 1,
      tool_call_id: toolCallId,
      tool_name: toolName,
    });
    writeMessage(notification('tool.result', {
      request_id: requestId,
      session_id: sessionId,
      trace_id: String(params.trace_id || requestId),
      tool_name: toolName,
      tool_call_id: toolCallId,
      tool_input: toolInput,
      success: true,
      output: JSON.stringify(toolOutputPayload),
      content_type: 'text',
      ...(mcpRetryMetadata && typeof mcpRetryMetadata === 'object'
        ? { metadata: { ...mcpRetryMetadata } }
        : {}),
    }));
    emitPhase('chat.phase_completed', 'tool_result', {
      iteration: 1,
      tool_call_id: toolCallId,
      tool_name: toolName,
    });
    emitTokens();
  };

  const emitPlanModeBlockedToolFlow = () => {
    writeMessage(notification('tool.executing', {
      request_id: requestId,
      session_id: sessionId,
      trace_id: String(params.trace_id || requestId),
      tool_name: toolName,
      tool_call_id: toolCallId,
      tool_input: toolInput,
    }));
    writeMessage(notification('tool.result', {
      request_id: requestId,
      session_id: sessionId,
      trace_id: String(params.trace_id || requestId),
      tool_name: toolName,
      tool_call_id: toolCallId,
      tool_input: toolInput,
      success: false,
      output: `Tool "${toolName}" is unavailable in plan mode because it has side effects.`,
      content_type: 'text',
      error_code: 'CMP-MODE-0002',
      metadata: {
        read_only_blocked: true,
      },
    }));
    emitTokens();
  };

  if (!requireApproval) {
    emitToolFlow();
    return;
  }

  if (planMode) {
    emitPlanModeBlockedToolFlow();
    return;
  }

  const pendingId = approvalRequestId;
  approvalRequestId += 1;
  pendingApprovals.set(pendingId, {
    requestId: id,
    params,
    toolCallId,
    toolName,
    emitApprovalCompleted() {
      emitPhase('chat.phase_completed', 'approval_wait', {
        iteration: 0,
        tool_call_id: toolCallId,
        tool_name: toolName,
        phase_id: `phase_approval_wait_${requestId}_${toolCallId}`,
      });
    },
    emitToolFlow,
  });
  emitPhase('chat.phase_started', 'approval_wait', {
    iteration: 0,
    tool_call_id: toolCallId,
    tool_name: toolName,
    phase_id: `phase_approval_wait_${requestId}_${toolCallId}`,
  });
  writeMessage({
    jsonrpc: JSONRPC_VERSION,
    api_version: API_VERSION,
    id: pendingId,
    method: 'tool.request_approval',
    params: {
      request_id: requestId,
      session_id: sessionId,
      trace_id: String(params.trace_id || requestId),
      api_version: API_VERSION,
      tool_name: toolName,
      tool_call_id: toolCallId,
      tool_input: toolInput,
      mode: 'assist',
    },
  });
}

function resolveApproval(message) {
  const pending = pendingApprovals.get(message.id);
  if (!pending) {
    return false;
  }
  pendingApprovals.delete(message.id);
  const approved = message.result?.approved === true;
  pending.emitApprovalCompleted?.();
  if (!approved) {
    writeMessage(resultResponse(pending.requestId, {
      request_id: String(pending.params.request_id || `req_${pending.requestId}`),
      status: 'denied',
    }));
    return true;
  }
  pending.emitToolFlow();
  return true;
}

function handleMessage(message) {
  if (!started) {
    return;
  }
  if (resolveApproval(message)) {
    return;
  }
  if (message.method === 'initialize') {
    const config = message.params?.config || {};
    currentConfig = config;
    currentActiveEngine = String(config.engine_type || 'mock');
    currentActiveModel = String(config.model ?? '').trim();
    const availableTools = buildAvailableTools(config);
    const toolsStatus = buildToolsStatus(config, availableTools);
    writeMessage(resultResponse(message.id, {
      api_version: API_VERSION,
      server_version: '0.1.0',
      active_engine: currentActiveEngine,
      active_model: currentActiveModel,
      active_model_capabilities: buildActiveModelCapabilities(currentActiveModel),
      active_model_reasoning_support: buildActiveModelReasoningSupport(
        currentActiveEngine,
        currentActiveModel
      ),
      provider_capabilities: buildProviderCapabilities(),
      tools_status: toolsStatus,
      tools_available: availableTools,
      mcp_tools_available: availableTools,
      feature_flags: config.feature_flags || {},
      memory: {
        db_path: String(config.memory_db_path || ''),
        journal_mode: 'wal',
      },
    }));
    return;
  }
  if (message.method === 'models.list') {
    const engineType = String(message.params?.engine_type || 'mock');
    const models = engineType === 'ollama'
      ? [
          { id: 'qwen3.5:9b', capabilities: { thinking: true } },
          'llama3.2',
        ]
      : engineType === 'vllm'
        ? ['Qwen/Qwen3.5-9B']
        : ['mock-v1', 'mock-v2'];
    const available = ['ollama', 'vllm', 'mock'].includes(engineType);
    writeMessage(resultResponse(message.id, {
      engine_type: engineType,
      models: available ? models : [],
      stale: false,
      available,
      reason: available ? '' : `provider '${engineType}' is unavailable`,
    }));
    return;
  }
  if (message.method === 'models.unload') {
    currentActiveModel = '';
    writeMessage(resultResponse(message.id, {
      status: 'ok',
      model: '',
    }));
    return;
  }
  if (message.method === 'chat.cancel') {
    writeMessage(resultResponse(message.id, {
      request_id: String(message.params?.request_id || '').trim(),
      status: 'cancel_requested',
      tombstone_hit: false,
    }));
    return;
  }
  if (message.method === 'chat.send') {
    if (Array.isArray(message.params?.attachments) && message.params.attachments.length) {
      sendChatCompletion(message.id, message.params, { withTool: false });
      return;
    }
    const content = latestUserContent(message.params);
    if (/\b(weather|forecast|temperature|latest|current)\b/i.test(content)) {
      if (currentConfig.tools_web_enabled === true) {
        sendChatCompletion(message.id, message.params, {
          withTool: true,
          requireApproval: false,
          forcedToolName: 'web_search',
        });
        return;
      }
      sendChatCompletion(message.id, message.params, {
        withTool: false,
        unavailableToolReason: 'config disabled',
      });
      return;
    }
    if (/mcp reconnect/i.test(content)) {
      sendChatCompletion(message.id, message.params, {
        withTool: true,
        requireApproval: false,
        forcedToolName: 'mcp__docs__lookup',
        mcpRetryMetadata: {
          mcp_retry_count: 1,
          mcp_reconnected_server: 'docs',
        },
      });
      return;
    }
    if (/approval/i.test(content) || /write/i.test(content)) {
      sendChatCompletion(message.id, message.params, { withTool: true, requireApproval: true });
      return;
    }
    if (/tool/i.test(content) || /read/i.test(content)) {
      sendChatCompletion(message.id, message.params, { withTool: true, requireApproval: false });
      return;
    }
    sendChatCompletion(message.id, message.params, { withTool: false });
    return;
  }
  if (message.method === 'memory.suggest') {
    const suggestion = buildMemorySuggestion(message.params, savedMemories);
    if (suggestion && message.params?.session_id) {
      upsertPendingMemory(message.params.session_id, suggestion);
    }
    writeMessage(resultResponse(message.id, {
      suggestions: suggestion ? [suggestion] : [],
    }));
    return;
  }
  if (message.method === 'background.run') {
    writeMessage(resultResponse(message.id, {
      status: 'started',
      task: String(message.params?.task || '').trim().toLowerCase() || 'automation_run',
    }));
    return;
  }
  if (message.method === 'memory.save') {
    const response = saveMemory(message.params, savedMemories, nextMemoryId);
    nextMemoryId = response.nextMemoryId;
    if (response.errorDetail) {
      writeMessage({
        jsonrpc: JSONRPC_VERSION,
        api_version: API_VERSION,
        id: message.id,
        error: {
          code: -32602,
          message: 'memory.save invalid params',
          data: {
            code: 'CMP-MEM-0001',
            detail: response.errorDetail,
            api_version: API_VERSION,
          },
        },
      });
      return;
    }
    if (response.result?.memory?.session_id && response.result?.memory?.content_fingerprint) {
      deletePendingMemoryRecord(
        response.result.memory.session_id,
        response.result.memory.content_fingerprint
      );
    }
    writeMessage(resultResponse(message.id, response.result));
    return;
  }
  if (message.method === 'memory.list') {
    writeMessage(resultResponse(message.id, {
      memories: listApprovedMemories(savedMemories),
    }));
    return;
  }
  if (message.method === 'memory.pending.list') {
    writeMessage(resultResponse(message.id, {
      candidates: listPendingMemories(),
    }));
    return;
  }
  if (message.method === 'memory.update') {
    const response = updateMemory(message.params, savedMemories);
    if (response.errorDetail) {
      writeMessage({
        jsonrpc: JSONRPC_VERSION,
        api_version: API_VERSION,
        id: message.id,
        error: {
          code: -32602,
          message: 'memory.update invalid params',
          data: {
            code: 'CMP-MEM-0001',
            detail: response.errorDetail,
            api_version: API_VERSION,
          },
        },
      });
      return;
    }
    writeMessage(resultResponse(message.id, response.result));
    return;
  }
  if (message.method === 'memory.delete') {
    const response = deleteMemory(message.params, savedMemories);
    if (response.errorDetail) {
      writeMessage({
        jsonrpc: JSONRPC_VERSION,
        api_version: API_VERSION,
        id: message.id,
        error: {
          code: -32602,
          message: 'memory.delete invalid params',
          data: {
            code: 'CMP-MEM-0001',
            detail: response.errorDetail,
            api_version: API_VERSION,
          },
        },
      });
      return;
    }
    writeMessage(resultResponse(message.id, response.result));
    return;
  }
  if (message.method === 'memory.pending.delete') {
    const sessionId = String(message.params?.session_id || '').trim();
    const contentFingerprint = String(message.params?.content_fingerprint || '').trim().toLowerCase();
    if (!sessionId || !contentFingerprint) {
      writeMessage({
        jsonrpc: JSONRPC_VERSION,
        api_version: API_VERSION,
        id: message.id,
        error: {
          code: -32602,
          message: 'memory.pending.delete invalid params',
          data: {
            code: 'CMP-MEM-0001',
            detail: !sessionId ? 'session_id is required' : 'content_fingerprint is required',
            api_version: API_VERSION,
          },
        },
      });
      return;
    }
    writeMessage(resultResponse(message.id, {
      deleted: deletePendingMemoryRecord(sessionId, contentFingerprint),
    }));
    return;
  }
  if (message.method === 'memory.recall') {
    writeMessage(resultResponse(message.id, {
      memories: recallMemories(message.params, savedMemories),
    }));
    return;
  }
  if (message.method === 'memory.recall_recent') {
    writeMessage(resultResponse(message.id, {
      memories: recallRecentMemories(message.params, savedMemories),
    }));
    return;
  }
  if (message.method === 'shutdown') {
    writeMessage(resultResponse(message.id, {
      status: 'shutting_down',
      api_version: API_VERSION,
    }));
    process.exit(0);
  }
  writeMessage({
    jsonrpc: JSONRPC_VERSION,
    api_version: API_VERSION,
    id: message.id,
    error: {
      code: -32601,
      message: `unknown method: ${message.method}`,
    },
  });
}

function start() {
  started = true;
  process.stdin.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, Buffer.from(chunk)]);
    parseMessages();
  });
  // Stdin EOF is the real sidecar's only live tie to its parent (see
  // sidecar/runtime/parent_watchdog.py), so it exits when the pipe closes.
  // Without that here, a shell stopped before it ever built a sidecar client
  // has no `shutdown` RPC to send -- only an stdin close -- and the fixture
  // survives to SidecarManager's force-kill fallback, the exit path a loaded
  // machine loses (orphan pins the runner's event loop on its stdio pipes).
  process.stdin.on('end', () => {
    process.exit(0);
  });
}

if (progressIntervalMs > 0) {
  progressTimer = setInterval(() => {
    process.stderr.write(`startup progress ${Date.now()}\n`);
  }, progressIntervalMs);
}

setTimeout(() => {
  if (progressTimer) {
    clearInterval(progressTimer);
    progressTimer = null;
  }
  start();
}, delayMs);
