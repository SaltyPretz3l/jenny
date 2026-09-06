(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererRenderPipelineTimelineAdapter = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function createRenderPipelineTimelineAdapter(deps) {
    const settings = deps || {};
    const globalRef = typeof globalThis !== 'undefined' ? globalThis : {};
    const messageIndexUtils = settings.messageIndexUtils
      || globalRef.rendererMessageIndexUtils
      || {};
    const threadTreeUtils = settings.threadTreeUtils
      || globalRef.rendererThreadTreeUtils
      || (typeof require === 'function' ? require('./renderer-thread-tree-utils') : null)
      || {};
    const timelineOrientationUtils = settings.timelineOrientationUtils || {};
    const buildTimelineStructureSignature = typeof settings.buildTimelineStructureSignature === 'function'
      ? settings.buildTimelineStructureSignature
      : () => '';
    const miFn = (name) => (
      typeof messageIndexUtils[name] === 'function' ? messageIndexUtils[name] : null
    );

    // Resume-affordance tail. The fallback returns '' rather than guessing: an
    // empty tail hides the affordance, which is the safe direction.
    const resolveResumeTailAssistantMessageId = miFn('resolveResumeTailAssistantMessageId')
      || function fallbackResolveResumeTailAssistantMessageId() { return ''; };

    const computeDerivedMessageState = miFn('computeDerivedMessageState')
      || function fallbackComputeDerivedMessageState(messages, options) {
        const list = Array.isArray(messages) ? messages : [];
        const adapterSettings = options || {};
        const thinkingPredicate = typeof adapterSettings.shouldShowThinkingToggle === 'function'
          ? adapterSettings.shouldShowThinkingToggle
          : null;
        const nonAssistantKinds = new Set([
          'interactive_round_recap',
          'slash_command_output',
        ]);
        const nonReplyAssistantKinds = new Set([
          'interactive_round_recap',
          'proactive_suggestion',
          'question_batch',
          'slash_command_output',
          'tool_use',
        ]);
        const streamingIneligibleKinds = new Set([
          'question_batch',
          'interactive_round_recap',
          'slash_command_output',
        ]);
        const streamTailToolKinds = new Set([
          'tool_use',
          'tool_result',
        ]);

        let latestAssistantMessageId = '';
        let latestReplyAssistantMessageId = '';
        let latestStreamTargetAssistantMessageId = '';
        let streamingMessage = null;
        const thinkingMessageIds = [];
        const idToIndex = new Map();

        for (let index = list.length - 1; index >= 0; index -= 1) {
          const message = list[index];
          if (!message) {
            continue;
          }
          const messageId = String(message.id || '');
          const role = String(message.role || '');
          const kind = String(message.kind || '');
          const status = String(message.status || '');

          idToIndex.set(messageId, index);

          if (!latestAssistantMessageId && role === 'assistant' && !nonAssistantKinds.has(kind)) {
            latestAssistantMessageId = messageId;
          }
          if (
            !latestStreamTargetAssistantMessageId
            && role === 'assistant'
            && !nonAssistantKinds.has(kind)
            && !streamTailToolKinds.has(kind)
          ) {
            latestStreamTargetAssistantMessageId = messageId;
          }
          if (!latestReplyAssistantMessageId && role === 'assistant' && !nonReplyAssistantKinds.has(kind) && status === 'complete') {
            latestReplyAssistantMessageId = messageId;
          }
          if (
            !streamingMessage
            && role === 'assistant'
            && status === 'streaming'
            && messageId === latestStreamTargetAssistantMessageId
            && !streamingIneligibleKinds.has(kind)
          ) {
            streamingMessage = message;
          }
          if (thinkingPredicate && thinkingPredicate(message)) {
            thinkingMessageIds.push(messageId);
          }
        }

        thinkingMessageIds.reverse();

        return {
          latestAssistantMessageId,
          latestReplyAssistantMessageId,
          thinkingMessageIds,
          streamingMessage,
          idToIndex,
        };
      };
    const computeTailFingerprint = miFn('tailFingerprint') || (() => '');
    const buildMessageProjectionFingerprint = miFn('buildMessageProjectionFingerprint') || computeTailFingerprint;
    const buildMessageRenderSignature = miFn('buildMessageRenderSignature') || ((messages) => (
      Array.isArray(messages) ? messages : []
    ).map((message) => computeTailFingerprint(message)).join('|'));
    const computeProjectionSignature = miFn('computeProjectionSignature') || buildTimelineStructureSignature;
    const computeMessageFingerprintList = miFn('computeMessageFingerprintList') || ((messages) => (
      Array.isArray(messages) ? messages : []
    ).map((message) => {
      const content = String(buildMessageProjectionFingerprint(message) || '');
      return { content, structural: content };
    }));
    const renderSignatureFromFingerprints = miFn('renderSignatureFromFingerprints') || ((fingerprints) => (
      Array.isArray(fingerprints) ? fingerprints : []
    ).map((entry) => String(entry?.content || '')).join('|'));
    const computeProjectionSignatureFromFingerprints = miFn('computeProjectionSignatureFromFingerprints')
      || ((fingerprints) => (Array.isArray(fingerprints) ? fingerprints : [])
        .map((entry) => String(entry?.structural || '')).join('|'));
    const computeStructureHash = miFn('computeStructureHash') || buildTimelineStructureSignature;
    const computeTurnStructureHash = miFn('computeTurnStructureHash') || (() => 0);
    const computeTurnTailFingerprint = miFn('computeTurnTailFingerprint') || (() => '');
    const deriveTimelineTimeDividers = timelineOrientationUtils
      && typeof timelineOrientationUtils.deriveTimelineTimeDividers === 'function'
      ? timelineOrientationUtils.deriveTimelineTimeDividers
      : function fallbackDeriveTimelineTimeDividers() { return []; };
    const buildTimeDividerMap = timelineOrientationUtils
      && typeof timelineOrientationUtils.buildTimeDividerMap === 'function'
      ? timelineOrientationUtils.buildTimeDividerMap
      : function fallbackBuildTimeDividerMap() { return new Map(); };
    const buildTimelineDividerInputSignature = timelineOrientationUtils
      && typeof timelineOrientationUtils.buildTimelineDividerInputSignature === 'function'
      ? timelineOrientationUtils.buildTimelineDividerInputSignature
      : function fallbackBuildTimelineDividerInputSignature() { return ''; };
    const buildTranscriptThreadTree = typeof threadTreeUtils.buildTranscriptThreadTree === 'function'
      ? threadTreeUtils.buildTranscriptThreadTree
      : function fallbackBuildTranscriptThreadTree(messages) {
        return {
          roots: (Array.isArray(messages) ? messages : []).map(function mapMessage(message, index) {
            return {
              id: String(message?.id || `message_${index}`),
              index,
              role: String(message?.role || '').trim(),
              kind: String(message?.kind || '').trim(),
              message,
              parentId: '',
              children: [],
            };
          }),
          nodeById: new Map(),
          hasNestedNodes: false,
        };
      };
    const collectThreadBranchIds = typeof threadTreeUtils.collectThreadBranchIds === 'function'
      ? threadTreeUtils.collectThreadBranchIds
      : function fallbackCollectThreadBranchIds(nodeById, messageId) {
        const ids = typeof threadTreeUtils.collectThreadAncestorIds === 'function'
          ? threadTreeUtils.collectThreadAncestorIds(nodeById, messageId)
          : new Set();
        const normalizedMessageId = String(messageId || '').trim();
        if (normalizedMessageId) {
          ids.add(normalizedMessageId);
        }
        return ids;
      };
    const shouldShowThreadToggle = typeof threadTreeUtils.shouldShowThreadToggle === 'function'
      ? threadTreeUtils.shouldShowThreadToggle
      : function fallbackShouldShowThreadToggle() { return false; };

    return {
      computeDerivedMessageState,
      resolveResumeTailAssistantMessageId,
      computeTailFingerprint,
      buildMessageProjectionFingerprint,
      buildMessageRenderSignature,
      computeMessageFingerprintList,
      renderSignatureFromFingerprints,
      computeProjectionSignature,
      computeProjectionSignatureFromFingerprints,
      computeStructureHash,
      computeTurnStructureHash,
      computeTurnTailFingerprint,
      deriveTimelineTimeDividers,
      buildTimeDividerMap,
      buildTimelineDividerInputSignature,
      buildTranscriptThreadTree,
      collectThreadBranchIds,
      shouldShowThreadToggle,
    };
  }

  return {
    createRenderPipelineTimelineAdapter,
  };
});
