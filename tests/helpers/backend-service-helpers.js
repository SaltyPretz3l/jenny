function waitForChatStreamEvent(service, predicate, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      service.off('chat-stream', handler);
      reject(new Error(`waitForChatStreamEvent timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    const handler = (event) => {
      if (!predicate(event)) {
        return;
      }
      clearTimeout(timer);
      service.off('chat-stream', handler);
      resolve(event);
    };
    service.on('chat-stream', handler);
  });
}

function collectServiceLogs(service) {
  const entries = [];
  service.on('service-log', (entry) => {
    entries.push(entry);
  });
  return entries;
}

function buildInteractiveAnswer(batch, optionId) {
  const question = batch.questions[0];
  const selectedOptionId = optionId || question.options[0].id;
  return {
    batch_id: batch.batch_id,
    round_index: batch.round_index,
    disposition: 'answered',
    batch_snapshot: batch,
    answers: [
      {
        question_id: question.id,
        option_id: selectedOptionId,
        text: '',
      },
    ],
  };
}

function buildInteractiveAnswers(batch, answerMap = {}) {
  return {
    batch_id: batch.batch_id,
    round_index: batch.round_index,
    disposition: 'answered',
    batch_snapshot: batch,
    answers: batch.questions.map((question) => {
      const configured = answerMap[question.id];
      if (typeof configured === 'string') {
        return {
          question_id: question.id,
          option_id: configured,
          text: '',
        };
      }
      if (configured && typeof configured === 'object') {
        return {
          question_id: question.id,
          option_id: String(configured.option_id || ''),
          text: String(configured.text || ''),
        };
      }
      return {
        question_id: question.id,
        option_id: question.options[0].id,
        text: '',
      };
    }),
  };
}

function createMockToolExecutor(options = {}) {
  const executeResults = options.executeResults || {};
  const defaultResult = {
    content: 'mock tool output',
    summary: 'mock summary',
    isError: false,
    approvalState: 'auto',
    durationMs: 10,
    metadata: {},
  };
  const executeCalls = [];
  const pendingApprovals = new Map();
  const streamApprovals = new Map();

  const registry = {
    getTool(name) {
      return {
        name,
        readOnly: name === 'Read' || name === 'Glob' || name === 'Grep',
        summarize(input) {
          return `${name} ${input.file_path || input.pattern || ''}`.trim();
        },
      };
    },
    getToolSchemas() {
      return [
        { type: 'function', function: { name: 'Read', description: 'Read file', parameters: {} } },
        { type: 'function', function: { name: 'Write', description: 'Write file', parameters: {} } },
      ];
    },
  };

  const permissionStore = {
    getAllPolicies() {
      return options.policies || { Read: 'auto', Write: 'ask', Glob: 'auto', Grep: 'auto' };
    },
  };

  return {
    registry,
    _permissionStore: permissionStore,
    getToolPolicy(toolName) {
      const policies = permissionStore.getAllPolicies();
      return policies[toolName] || 'ask';
    },
    executeCalls,
    _pendingApprovals: pendingApprovals,
    _streamApprovals: streamApprovals,
    async execute(call, context) {
      executeCalls.push({ call, context });
      const result = executeResults[call.toolName] || executeResults[call.callId] || defaultResult;
      if (typeof result === 'function') {
        return result(call, context);
      }
      return { ...defaultResult, ...result, callId: call.callId, toolName: call.toolName };
    },
    approve(callId) { return false; },
    deny(callId) { return false; },
    cancelPendingForStream(streamId) {
      const callIds = streamApprovals.get(streamId);
      if (callIds) {
        for (const callId of callIds) {
          pendingApprovals.delete(callId);
        }
        streamApprovals.delete(streamId);
      }
    },
  };
}

function createApprovalBlockingToolExecutor() {
  let releaseApproval = null;
  const executeCalls = [];

  return {
    registry: {
      getTool(name) {
        return {
          name,
          readOnly: false,
          summarize(input) {
            return `${name} ${input.file_path || ''}`.trim();
          },
        };
      },
      getToolSchemas() {
        return [
          { type: 'function', function: { name: 'Read', description: 'Read file', parameters: {} } },
        ];
      },
    },
    _permissionStore: {
      getAllPolicies() {
        return { Read: 'ask' };
      },
    },
    getToolPolicy(toolName) {
      return { Read: 'ask' }[toolName] || 'ask';
    },
    async execute(call) {
      executeCalls.push(call);
      await new Promise((resolve) => {
        releaseApproval = resolve;
      });
      return {
        callId: call.callId,
        toolName: call.toolName,
        content: 'approved output',
        summary: 'approved summary',
        isError: false,
        approvalState: 'approved',
        durationMs: 5,
        metadata: {},
      };
    },
    approve() {
      if (releaseApproval) {
        releaseApproval();
      }
      return true;
    },
    deny() {
      return false;
    },
    cancelPendingForStream() {},
    executeCalls,
  };
}

function createAbortAwareToolExecutor() {
  const executeCalls = [];

  return {
    registry: {
      getTool(name) {
        return {
          name,
          readOnly: true,
          summarize(input) {
            return `${name} ${input.file_path || ''}`.trim();
          },
        };
      },
      getToolSchemas() {
        return [
          { type: 'function', function: { name: 'Read', description: 'Read file', parameters: {} } },
        ];
      },
    },
    _permissionStore: {
      getAllPolicies() {
        return { Read: 'auto' };
      },
    },
    getToolPolicy(toolName) {
      return { Read: 'auto' }[toolName] || 'ask';
    },
    async execute(call, context) {
      executeCalls.push(call.callId);
      if (call.callId === 'call_1') {
        await new Promise((resolve) => {
          if (context.abortSignal.aborted) {
            resolve();
            return;
          }
          context.abortSignal.addEventListener('abort', resolve, { once: true });
        });
        return {
          callId: call.callId,
          toolName: call.toolName,
          content: 'cancelled',
          summary: 'cancelled',
          isError: true,
          approvalState: 'cancelled',
          durationMs: 1,
          metadata: {},
        };
      }

      return {
        callId: call.callId,
        toolName: call.toolName,
        content: 'unexpected second tool execution',
        summary: 'unexpected',
        isError: false,
        approvalState: 'auto',
        durationMs: 1,
        metadata: {},
      };
    },
    approve() { return false; },
    deny() { return false; },
    cancelPendingForStream() {},
    executeCalls,
  };
}

module.exports = {
  waitForChatStreamEvent,
  collectServiceLogs,
  buildInteractiveAnswer,
  buildInteractiveAnswers,
  createMockToolExecutor,
  createApprovalBlockingToolExecutor,
  createAbortAwareToolExecutor,
};
