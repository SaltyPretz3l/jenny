const {
  buildLinkedSessionContext,
} = require('./linked-session-recall');
const {
  getGitContextForChat,
} = require('./git-context-utils');
const {
  getCodebaseContext,
} = require('./codebase-context-utils');
const {
  buildActiveFileContextBlock,
} = require('./active-file-context-utils');
const {
  computeEffectiveContextBudget,
  estimateMessagesTokens,
  trimContextBlocks,
  DEFAULT_SYSTEM_RESERVE_TOKENS,
} = require('./context-budget-trimmer');
const {
  normalizeContextBlocksForSend,
} = require('./chat-send-context-blocks');

function summarizeTextBlock(text) {
  const normalized = String(text || '');
  if (!normalized) {
    return null;
  }
  return {
    message_count: 1,
    char_count: normalized.length,
    approx_tokens: Math.max(1, Math.ceil(normalized.length / 4)),
  };
}

async function assembleContextForChat(service, options) {
  const {
    resolvedSessionId,
    streamId,
    engineType,
    contextPreferences,
    sessionSummary,
    prompt,
    recentUserTurns,
    promptHasExplicitStyleInstruction,
    preparedMessages,
    recallQuery,
    logTiming,
    activeFileContext,
    mentionContents,
  } = options;

  const usesMinimalSystemPrompt =
    String(engineType || service.currentEngineType || '').trim().toLowerCase() === 'chatgpt';
  const shouldIncludePersonality =
    !usesMinimalSystemPrompt
    && contextPreferences.include_personality !== false
    && service.personalityWorkspace
    && typeof service.personalityWorkspace.getCompiledContext === 'function';
  const shouldIncludeMemory = contextPreferences.include_memory !== false;
  const hasConfigGet =
    service.configService && typeof service.configService.get === 'function';
  const shouldIncludeGitContext =
    contextPreferences.include_git_context !== false && hasConfigGet;
  // Codebase grounding ("local RAG-lite") is opt-in: gated behind the
  // default-ON workspace_codebase_context flag AND the include_codebase_context
  // context preference AND a configured workspace root. It is independent of the
  // git-context preference.
  const codebaseWorkspaceRoot = hasConfigGet
    ? String(service.configService.get('tools_workspace_root') || '').trim()
    : '';
  const shouldIncludeCodebaseContext =
    service.featureFlags?.workspace_codebase_context === true
    && contextPreferences.include_codebase_context !== false
    && Boolean(codebaseWorkspaceRoot);
  const codebaseQuery = recallQuery || prompt || '';
  // Implicit active-file context + @-mentions (Tier-3): gated behind the
  // default-ON workspace_active_file_context flag AND the
  // include_active_file_context preference. Unlike codebase grounding the
  // backend does NOT self-fetch — the renderer supplies the cursor-region slice
  // (activeFileContext) and the resolved @-mention contents (mentionContents)
  // on the per-turn payload, having already deduped them against each other and
  // any composer attachments.
  const shouldIncludeActiveFileContext =
    service.featureFlags?.workspace_active_file_context === true
    && contextPreferences.include_active_file_context !== false
    && (
      Boolean(activeFileContext && activeFileContext.slice)
      || (Array.isArray(mentionContents) && mentionContents.length > 0)
    );
  // Cross-source dedupe (codebase vs active-file): when the active-file block
  // will actually carry the open file's slice, exclude that path from the
  // codebase keyword search so the same file is never grounded twice (active
  // file at its cursor range PLUS a codebase snippet at another range). Only the
  // active file is excluded — @-mentions are out of scope. When active-file
  // context is off there is no double-send, so the exclude stays empty.
  const activeFileExcludePath =
    shouldIncludeActiveFileContext && activeFileContext && activeFileContext.slice
      ? String(activeFileContext.path || '').trim()
      : '';
  const codebaseExcludePaths = activeFileExcludePath ? [activeFileExcludePath] : [];
  const promptContributions = {};

  // Each parallel task records its own elapsed time so context-assembly latency
  // can be attributed to the specific sub-step.
  async function timed(fn) {
    const startedAt = Date.now();
    try {
      const value = await fn();
      return { value, elapsedMs: Math.max(Date.now() - startedAt, 0) };
    } catch (error) {
      // Preserve the elapsed-until-error measurement so we can still
      // attribute slow failures (e.g., a timed-out memory recall).
      const elapsedMs = Math.max(Date.now() - startedAt, 0);
      const wrapped = new Error(error?.message || String(error));
      wrapped.cause = error;
      wrapped.elapsedMs = elapsedMs;
      throw wrapped;
    }
  }
  const parallelStartedAt = Date.now();
  const [
    personalityResult,
    gitResult,
    codebaseResult,
    activeFileResult,
  ] = await Promise.allSettled([
    timed(() =>
      shouldIncludePersonality
        ? service.personalityWorkspace.getCompiledContext()
        : Promise.resolve('')
    ),
    timed(() =>
      shouldIncludeGitContext
        ? getGitContextForChat(
            service.configService.get('tools_workspace_root') || ''
          ).catch(() => null)
        : Promise.resolve(null)
    ),
    timed(() =>
      shouldIncludeCodebaseContext
        ? getCodebaseContext(codebaseWorkspaceRoot, codebaseQuery, {
          excludePaths: codebaseExcludePaths,
        }).catch(() => null)
        : Promise.resolve(null)
    ),
    // Synchronous pure builder (no I/O — the renderer already resolved the
    // content); wrapped in timed()/Promise.resolve to keep the uniform
    // {value,elapsedMs} shape the splice/timing code below relies on.
    timed(() =>
      shouldIncludeActiveFileContext
        ? Promise.resolve(buildActiveFileContextBlock(activeFileContext, mentionContents))
        : Promise.resolve(null)
    ),
  ]);
  // elapsedFor pulls the per-task duration from the timed() wrapper; on
  // rejection we still captured elapsedMs before rethrowing.
  function elapsedFor(settled) {
    if (settled.status === 'fulfilled') {
      return Number(settled.value?.elapsedMs) || 0;
    }
    return Number(settled.reason?.elapsedMs) || 0;
  }
  function fakeStartedAt(settled) {
    // logTiming computes elapsedMs as (Date.now() - startedAt); passing
    // (Date.now() - elapsedFor(settled)) reproduces the task-specific
    // duration without changing logTiming's signature.
    return Date.now() - elapsedFor(settled);
  }
  logTiming('chat.personality_compiled', fakeStartedAt(personalityResult), {
    eligible: shouldIncludePersonality,
    hasContext:
      personalityResult.status === 'fulfilled'
      && Boolean(String(personalityResult.value?.value || '').trim()),
  });
  if (personalityResult.status === 'rejected') {
    const cause = personalityResult.reason?.cause || personalityResult.reason;
    service._emitServiceLog('WARN', 'chat.personality_compile_failed', {
      sessionId: resolvedSessionId,
      streamId,
      errorCode: String(cause?.code || 'PERSONALITY_COMPILE_FAILED').slice(0, 80),
      errorName: String(cause?.name || 'Error').slice(0, 80),
    });
  }
  logTiming('chat.memory_policy_forwarded', Date.now(), {
    included: shouldIncludeMemory,
  });
  logTiming('chat.git_context_resolved', fakeStartedAt(gitResult), {
    included: shouldIncludeGitContext,
    hasContext:
      gitResult.status === 'fulfilled'
      && Boolean(gitResult.value?.value),
  });
  logTiming('chat.codebase_context_resolved', fakeStartedAt(codebaseResult), {
    included: shouldIncludeCodebaseContext,
    hasContext:
      codebaseResult.status === 'fulfilled'
      && Boolean(codebaseResult.value?.value),
  });
  logTiming('chat.active_file_context_resolved', fakeStartedAt(activeFileResult), {
    included: shouldIncludeActiveFileContext,
    hasContext:
      activeFileResult.status === 'fulfilled'
      && Boolean(activeFileResult.value?.value),
  });
  // Summary marker: when the parallel block settled, plus a breakdown
  // of each task's elapsed time. This single DEBUG line makes it trivial
  // to see which of the four was the critical-path task for this turn.
  // memoryMs is the wall-clock elapsed of the whole memory block; because
  // memory.recall and memory.recall_recent now run in parallel, memoryMs
  // ≈ max(recallMs, recentMs) + small overhead. memoryRecallMs and
  // memoryRecentMs are extracted from the memory block's payload so we
  // can attribute remaining variance to one RPC vs the other.
  const contextAssemblyBreakdown = {
    parallelElapsedMs: Math.max(Date.now() - parallelStartedAt, 0),
    personalityMs: elapsedFor(personalityResult),
    memoryMs: 0,
    memoryRecallMs: 0,
    memoryRecentMs: 0,
    gitMs: elapsedFor(gitResult),
    codebaseMs: elapsedFor(codebaseResult),
    activeFileMs: elapsedFor(activeFileResult),
    includedPersonality: false,
    includedMemory: shouldIncludeMemory,
    includedGitContext: shouldIncludeGitContext,
    includedCodebaseContext: shouldIncludeCodebaseContext,
    includedActiveFileContext: shouldIncludeActiveFileContext,
  };

  // NOTE: each Promise.allSettled entry is now wrapped by timed(), so the
  // raw task result lives at .value.value (outer `.value` = {value,
  // elapsedMs}, inner `.value` = the actual payload).
  // ── Build every candidate context block, then deterministically trim them to
  // the model's effective budget BEFORE splicing (see context-budget-trimmer.js
  // for the seam rationale: block identity is free here, the trim is pure and
  // zero-model). This is a general per-turn safety net — it runs regardless of
  // the workspace_active_file_context flag and is INERT unless the measured
  // budget is exceeded (so large-window models are untouched); on small local
  // windows it drops/shrinks the lowest-priority blocks so a turn never
  // overflows ("Conversation too long") on the very first message. NB: the
  // Most contextAssemblyBreakdown.included* flags report eligibility/build
  // state; includedPersonality is corrected after normalization to report the
  // block actually sent. The chat.context_budget_trimmed log carries the full
  // drop/shrink decisions. ──
  const personalityContext = personalityResult.status === 'fulfilled'
    ? String(personalityResult.value?.value || '').trim() : '';
  const gitContext = gitResult.status === 'fulfilled'
    ? String(gitResult.value?.value || '').trim() : '';
  const codebaseContext = codebaseResult.status === 'fulfilled'
    ? String(codebaseResult.value?.value || '').trim() : '';
  const activeFileContextBlock = activeFileResult.status === 'fulfilled'
    ? String(activeFileResult.value?.value || '').trim() : '';

  const linkedSessionEligible =
    contextPreferences.history_scope !== 'fresh'
    && Array.isArray(sessionSummary?.linked_session_ids)
    && sessionSummary.linked_session_ids.length > 0;
  const linkedSessionTimingStartedAt = Date.now();
  let linkedSessionContext = null;
  if (linkedSessionEligible) {
    linkedSessionContext = buildLinkedSessionContext(
      service.sessionStore,
      resolvedSessionId,
      prompt,
      recentUserTurns
    );
  }

  // Priority: higher kept longer, lowest dropped/shrunk first. Mirrors the
  // suggested order over the real block set — what the user is actively looking
  // at (or @-mentioned) ranks highest; auxiliary linked-session recall lowest.
  const candidateBlocks = [
    { kind: 'active_file', content: activeFileContextBlock, priority: 100, shrinkable: true },
    { kind: 'git', content: gitContext, priority: 80, shrinkable: true },
    { kind: 'personality', content: personalityContext, priority: 70, shrinkable: true },
    { kind: 'codebase', content: codebaseContext, priority: 60, shrinkable: true },
    {
      kind: 'linked_session',
      content: String(linkedSessionContext?.content || '').trim(),
      priority: 50,
      shrinkable: true,
    },
  ];
  const effectiveBudget = computeEffectiveContextBudget(
    service.currentStatus?.effective_context_length
  );
  const consumedTokens = estimateMessagesTokens(preparedMessages);
  const availableForBlocks = effectiveBudget == null
    ? null
    : Math.max(0, effectiveBudget - consumedTokens - DEFAULT_SYSTEM_RESERVE_TOKENS);
  const { kept: keptBlocks, decisions: trimDecisions } = trimContextBlocks(
    candidateBlocks,
    availableForBlocks
  );
  if (trimDecisions.some((d) => d.action === 'drop' || d.action === 'shrink')) {
    service._emitServiceLog('INFO', 'chat.context_budget_trimmed', {
      sessionId: resolvedSessionId,
      streamId,
      effectiveBudget,
      consumedTokens,
      availableForBlocks,
      decisions: trimDecisions,
    });
  }

  // Accumulate survivors as TYPED context blocks instead of splicing them into
  // preparedMessages as {role:'system'} rows. Request history is untrusted on
  // the sidecar — its semantic gate drops every system row it carries — so a
  // spliced block never reached the model at all. They now ride
  // `chat.send params.context_blocks` and the sidecar folds them into the
  // trusted system tier. Order is preserved as the old splice order read
  // top→bottom: personality, git, codebase, linked-session, and finally
  // active-file closest to the conversation (highest salience).
  const contextBlocks = [];
  function appendContextBlock(kind, content) {
    contextBlocks.push({ kind, content });
  }
  const personalityKept = keptBlocks.get('personality');
  if (personalityKept) {
    appendContextBlock('personality', personalityKept.content);
    promptContributions.personality_block = summarizeTextBlock(personalityKept.content);
  }
  const gitKept = keptBlocks.get('git');
  if (gitKept) {
    appendContextBlock('git', gitKept.content);
    promptContributions.git_block = summarizeTextBlock(gitKept.content);
  }
  const codebaseKept = keptBlocks.get('codebase');
  if (codebaseKept) {
    appendContextBlock('codebase', codebaseKept.content);
    promptContributions.codebase_block = summarizeTextBlock(codebaseKept.content);
  }
  const linkedKept = keptBlocks.get('linked_session');
  if (linkedKept && linkedSessionContext) {
    appendContextBlock('linked_session', linkedKept.content);
    promptContributions.linked_session_block = summarizeTextBlock(linkedKept.content);
  }
  logTiming('chat.linked_session_recall_completed', linkedSessionTimingStartedAt, {
    eligible: linkedSessionEligible,
    included: Boolean(linkedKept),
    linkedSessionCount: linkedSessionEligible ? sessionSummary.linked_session_ids.length : 0,
    charCount: String(linkedKept?.content || '').length,
  });
  const activeFileKept = keptBlocks.get('active_file');
  if (activeFileKept) {
    appendContextBlock('active_file', activeFileKept.content);
    promptContributions.active_file_block = summarizeTextBlock(activeFileKept.content);
  }
  const normalizedContextBlocks = normalizeContextBlocksForSend(contextBlocks, {
    onDrop: (info) => {
      service._emitServiceLog('WARN', 'chat.context_block_dropped', {
        sessionId: resolvedSessionId,
        streamId,
        ...info,
      });
    },
  });
  contextAssemblyBreakdown.includedPersonality = normalizedContextBlocks.some(
    (block) => block.kind === 'personality' && Boolean(String(block.content || '').trim())
  );
  service._emitServiceLog('DEBUG', 'chat.context_assembly_parallel_settled', {
    sessionId: resolvedSessionId,
    streamId,
    ...contextAssemblyBreakdown,
  });
  if (!shouldIncludeMemory) {
    service._emitServiceLog('INFO', 'memory.recall_skipped', {
      sessionId: resolvedSessionId,
      streamId,
      reason: 'context_preferences_include_memory_disabled',
    });
  }

  return {
    memoryPolicy: {
      enabled: shouldIncludeMemory,
      include_response_style: !promptHasExplicitStyleInstruction,
    },
    promptContributions,
    contextAssemblyBreakdown,
    contextBlocks: normalizedContextBlocks,
  };
}

module.exports = {
  assembleContextForChat,
};
