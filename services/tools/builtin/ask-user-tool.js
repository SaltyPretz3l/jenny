'use strict';

const crypto = require('node:crypto');

const { TOOL_ERROR_CODES } = require('../../backend/error-codes');

const LIMITS = Object.freeze({
  questions: 4,
  prompt: 500,
  options: 8,
  option: 120,
  id: 64,
  answer: 500,
});

function boundedString(value, limit, { required = false } = {}) {
  if (typeof value !== 'string') return required ? null : '';
  const normalized = value.trim();
  if (required && !normalized) return null;
  return normalized.slice(0, limit);
}

function uniqueQuestionId(value, index, seen) {
  const fallback = `q${index + 1}`;
  const base = boundedString(value, LIMITS.id) || fallback;
  if (!seen.has(base)) {
    seen.add(base);
    return base;
  }
  let suffixIndex = 2;
  while (true) {
    const suffix = `_${suffixIndex}`;
    const candidate = `${base.slice(0, LIMITS.id - suffix.length)}${suffix}`;
    if (!seen.has(candidate)) {
      seen.add(candidate);
      return candidate;
    }
    suffixIndex += 1;
  }
}

function normalizeQuestions(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || !Array.isArray(input.questions)) {
    return [];
  }
  const seen = new Set();
  const questions = [];
  for (const candidate of input.questions.slice(0, LIMITS.questions)) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) continue;
    const prompt = boundedString(candidate.prompt, LIMITS.prompt, { required: true });
    if (!prompt) continue;
    const id = uniqueQuestionId(candidate.id, questions.length, seen);
    const options = Array.isArray(candidate.options)
      ? candidate.options.slice(0, LIMITS.options)
        .map((option) => boundedString(option, LIMITS.option, { required: true }))
        .filter(Boolean)
      : [];
    questions.push({
      id,
      prompt,
      options,
      allow_other: candidate.allow_other === true,
      multi_select: candidate.multi_select === true,
    });
  }
  return questions;
}

function failure(content) {
  return {
    content,
    summary: 'User questions failed',
    isError: true,
    errorCode: TOOL_ERROR_CODES.EXECUTION_FAILED,
    metadata: { result_kind: 'user_questions' },
  };
}

function buildQuestionRef({ sessionId, streamId, callId, questionId }) {
  return ['question', sessionId, streamId, callId, questionId]
    .map((part) => String(part || '').trim())
    .filter(Boolean)
    .join('_');
}

function normalizeAnswers(questions, payload) {
  const submitted = Array.isArray(payload?.answers)
    ? payload.answers.slice(0, LIMITS.questions)
    : [];
  const firstById = new Map();
  for (const answer of submitted) {
    if (!answer || typeof answer !== 'object' || Array.isArray(answer)) continue;
    const id = boundedString(answer.id, LIMITS.id, { required: true });
    if (id && !firstById.has(id)) firstById.set(id, answer);
  }

  const answers = [];
  for (const question of questions) {
    const submittedAnswer = firstById.get(question.id);
    if (!submittedAnswer) continue;
    let value;
    if (question.multi_select) {
      const values = Array.isArray(submittedAnswer.value)
        ? submittedAnswer.value.slice(0, LIMITS.options)
        : [submittedAnswer.value];
      value = values
        .map((entry) => boundedString(entry, LIMITS.answer, { required: true }))
        .filter(Boolean);
    } else if (Array.isArray(submittedAnswer.value)) {
      value = submittedAnswer.value
        .map((entry) => boundedString(entry, LIMITS.answer, { required: true }))
        .find(Boolean) || '';
    } else {
      value = boundedString(submittedAnswer.value, LIMITS.answer);
    }
    const normalized = { id: question.id, value };
    const other = question.allow_other
      ? boundedString(submittedAnswer.other, LIMITS.answer)
      : '';
    if (other) normalized.other = other;
    answers.push(normalized);
  }
  return answers;
}

function buildTranscript(questions, answers) {
  const answerById = new Map(answers.map((answer) => [answer.id, answer]));
  const lines = [];
  for (const question of questions) {
    const answer = answerById.get(question.id);
    const renderedValue = Array.isArray(answer?.value)
      ? answer.value.join(', ')
      : answer?.value;
    const renderedOther = answer?.other ? ` (Other: ${answer.other})` : '';
    lines.push(`Q: ${question.prompt}\nA: ${renderedValue || '(no answer)'}${renderedOther}`);
  }
  return lines.length ? lines.join('\n\n') : 'The user submitted no answers.';
}

module.exports = {
  name: 'ask_user',
  description: 'Ask the user one to four structured questions and wait for their answers before continuing the turn.',
  category: 'builtin',
  readOnly: true,
  sideEffecting: false,
  planModeOnly: false,
  workspaceRequired: false,
  parameters: {},

  summarize(input) {
    const count = normalizeQuestions(input).length;
    return `Ask user ${count || 1} question${count === 1 ? '' : 's'}`;
  },

  async execute(input, context = {}) {
    const questions = normalizeQuestions(input);
    if (!questions.length) return failure('No usable question was provided.');

    const service = context.backendService;
    const sessionId = String(context.sessionId || '').trim();
    const streamId = String(context.streamId || '').trim();
    const callId = String(context.callId || '').trim();
    if (!service || !(service.pendingUserQuestions instanceof Map)
      || typeof service.emit !== 'function' || !sessionId || !streamId || !callId) {
      return failure('User questions are unavailable because the chat waiter is not initialized.');
    }

    const questionId = `question_${crypto.randomUUID()}`;
    const questionRef = buildQuestionRef({ sessionId, streamId, callId, questionId });
    let settleWaiter;
    const waiter = new Promise((resolve) => { settleWaiter = resolve; });
    let settled = false;
    const abortSignal = context.abortSignal;
    // This wait blocks the tool loop on a human answer, which the sidecar
    // credits against its own turn deadline (see
    // sidecar/ai/routing/tool_execution_ask_user_wait.py). Electron's
    // chat.send RPC timeout is otherwise a fixed deadline set at send time, so
    // without this the transport can abort the turn mid-wait even though the
    // sidecar considers the wait legitimate. Suspend at the start of the wait
    // (streamId doubles as the chat.send request_id / requestKey) and resume
    // in finish() below, which every settle path (answer/decline/abort/stream
    // end) already funnels through.
    const resumeRpcTimeout = typeof service.sidecarClient?.suspendRequestTimeout === 'function'
      ? service.sidecarClient.suspendRequestTimeout(streamId)
      : null;
    const handleAbort = () => finish({ declined: true });
    const finish = (payload = {}) => {
      if (settled) return;
      settled = true;
      abortSignal?.removeEventListener?.('abort', handleAbort);
      service.pendingUserQuestions.delete(questionRef);
      resumeRpcTimeout?.();
      settleWaiter(payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {});
    };

    service.pendingUserQuestions.set(questionRef, {
      questionId,
      questionRef,
      sessionId,
      streamId,
      callId,
      toolName: 'ask_user',
      questions,
      resolve: finish,
    });
    if (abortSignal?.aborted) {
      finish({ declined: true });
    } else {
      abortSignal?.addEventListener?.('abort', handleAbort, { once: true });
    }

    if (!settled) {
      try {
        service.emit('chat-stream', {
          type: 'user_questions_requested',
          streamId,
          sessionId,
          model: service.currentModel,
          callId,
          questionId,
          questionRef,
          toolName: 'ask_user',
          questions,
          input: { questions },
          summary: this.summarize({ questions }),
          status: 'pending_user_input',
          resultKind: 'user_questions',
        });
      } catch (_error) {
        finish({ failed: true });
        return failure('User questions could not be shown.');
      }
    }

    const resolution = await waiter;
    if (resolution.declined === true) {
      return {
        content: 'The user declined to answer.',
        summary: 'User declined questions',
        isError: false,
        metadata: { result_kind: 'user_questions_declined' },
      };
    }
    if (resolution.failed === true) {
      return failure('User questions could not be shown.');
    }
    const answers = normalizeAnswers(questions, resolution);
    return {
      content: buildTranscript(questions, answers),
      summary: 'User answered questions',
      isError: false,
      metadata: {
        result_kind: 'user_questions_answered',
        answers,
      },
    };
  },

  normalizeQuestions,
  normalizeAnswers,
  buildQuestionRef,
  LIMITS,
};
