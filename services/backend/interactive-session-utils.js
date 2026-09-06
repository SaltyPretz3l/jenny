const {
  normalizeInteractiveRoundCount,
  normalizeInteractiveRoundRecap,
  normalizePendingQuestionBatch,
} = require('./session-shadow-store');
const {
  normalizeQuestionBatchContinuationToken,
} = require('./message-normalization');

const MAX_INTERACTIVE_QUESTIONS = 5;
const MAX_INTERACTIVE_ROUNDS = 3;
const INTERACTIVE_SEQUENCE_IDLE = 'idle';
const INTERACTIVE_SEQUENCE_STRUCTURED_ACTIVE = 'structured_active';
const INTERACTIVE_SEQUENCE_FALLBACK_REQUESTED = 'fallback_requested';

function clipTitle(value) {
  return String(value || '').trim().slice(0, 80) || 'New Chat';
}

function normalizeInteractiveDisposition(value) {
  const token = String(value || '').trim().toLowerCase();
  return token === 'skipped' ? 'skipped' : 'answered';
}

function normalizeInteractiveAnswers(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((answer) => {
      if (!answer || typeof answer !== 'object' || Array.isArray(answer)) {
        return null;
      }
      const questionId = String(answer.question_id || '').trim();
      const optionId = String(answer.option_id || '').trim();
      const text = String(answer.text || '').trim();
      if (!questionId || (!optionId && !text)) {
        return null;
      }
      return {
        question_id: questionId,
        option_id: optionId,
        text,
      };
    })
    .filter(Boolean);
}

function normalizeInteractiveResponse(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  const batchSnapshot = normalizePendingQuestionBatch(value.batch_snapshot);
  const batchId = String(value.batch_id || batchSnapshot?.batch_id || '').trim();
  const roundIndex = Math.max(
    1,
    normalizeInteractiveRoundCount(value.round_index || batchSnapshot?.round_index) || 1
  );
  if (!batchId || !batchSnapshot) {
    return null;
  }

  const continuationToken = normalizeQuestionBatchContinuationToken(
    value.continuation_token ?? batchSnapshot.continuation_token
  );
  const canonicalContinuationToken =
    continuationToken?.batch_id === batchId
    && continuationToken.batch_id === batchSnapshot.batch_id
      ? continuationToken
      : null;

  return {
    batch_id: batchId,
    round_index: roundIndex,
    disposition: normalizeInteractiveDisposition(value.disposition),
    batch_snapshot: batchSnapshot,
    answers: normalizeInteractiveAnswers(value.answers),
    ...(canonicalContinuationToken
      ? { continuation_token: canonicalContinuationToken }
      : {}),
  };
}

function getInteractiveOptionLabels(question) {
  return (Array.isArray(question?.options) ? question.options : [])
    .map((option) => String(option?.label || '').trim())
    .filter(Boolean);
}

function formatInteractiveOptionLabels(question) {
  return getInteractiveOptionLabels(question).join(' / ');
}

function resolveInteractiveAnswerLabel(question, answers) {
  const answer = (Array.isArray(answers) ? answers : [])
    .find((entry) => entry.question_id === question.id);
  if (!answer) {
    return '';
  }
  const option = question.options.find((entry) => entry.id === answer.option_id);
  return String(answer.text || option?.label || '').trim();
}

function buildAutomaticSessionTitleCandidate(transcriptPrompt, interactiveResponse) {
  const promptText = String(transcriptPrompt || '').trim();
  return !interactiveResponse && promptText ? clipTitle(promptText) : '';
}

function isDefaultSessionTitle(value) {
  const title = String(value || '').trim();
  return !title || title === 'New Chat';
}

function isEmptySessionSummary(session) {
  if (!session || typeof session !== 'object') {
    return false;
  }
  return Math.max(Number(session.message_count || 0), 0) === 0;
}

function shouldApplyAutomaticSessionTitle(session, titleCandidate) {
  return Boolean(
    titleCandidate
    && isDefaultSessionTitle(session?.title)
    && isEmptySessionSummary(session)
  );
}

function buildInteractiveQuestionBatchSummary(batch) {
  const snapshot = normalizePendingQuestionBatch(batch);
  if (!snapshot) {
    return '';
  }

  const lines = [];
  if (snapshot.intro_text) {
    lines.push(snapshot.intro_text);
  }
  lines.push(
    ...snapshot.questions.map((question, index) => {
      const optionLabels = formatInteractiveOptionLabels(question);
      return `${index + 1}. ${question.prompt}${optionLabels ? ` (${optionLabels})` : ''}`;
    })
  );
  return lines.join('\n').trim();
}

function buildInteractiveQuestionBatchTranscript(batch) {
  const snapshot = normalizePendingQuestionBatch(batch);
  if (!snapshot) {
    return '';
  }

  const lines = ['Jenny asked follow-up questions:'];
  const introText = String(snapshot.intro_text || '').trim();
  if (introText) {
    lines.push(introText);
  }
  snapshot.questions.forEach((question, index) => {
    lines.push('');
    lines.push(`${index + 1}. ${question.prompt}`);
    const optionLabels = formatInteractiveOptionLabels(question);
    if (optionLabels) {
      lines.push(`Options: ${optionLabels}`);
    }
  });
  return lines.join('\n').trim();
}

function buildInteractiveRoundRecapTranscript(recap) {
  const normalized = normalizeInteractiveRoundRecap(recap);
  if (!normalized) {
    return '';
  }

  const lines = ["User answered Jenny's follow-up questions:"];
  for (const item of normalized.items) {
    lines.push(`- ${item.prompt}: ${item.answer_label}`);
  }
  return lines.join('\n').trim();
}

function buildInteractiveQuestionBatchVisibleText(batch) {
  return buildInteractiveQuestionBatchTranscript(batch);
}

function buildInteractiveRoundRecap(response) {
  const normalized = normalizeInteractiveResponse(response);
  if (!normalized || normalized.disposition !== 'answered') {
    return null;
  }

  const items = normalized.batch_snapshot.questions
    .map((question) => {
      const answerLabel = resolveInteractiveAnswerLabel(question, normalized.answers);
      if (!answerLabel) {
        return null;
      }
      return {
        question_id: question.id,
        prompt: question.prompt,
        answer_label: answerLabel,
      };
    })
    .filter(Boolean);

  if (!items.length) {
    return null;
  }

  return {
    round_index: normalized.round_index,
    answer_count: items.length,
    items,
    collapsed: false,
  };
}

function hasValidInteractiveQuestionCount(batch) {
  const normalized = normalizePendingQuestionBatch(batch);
  const questionCount = Array.isArray(normalized?.questions) ? normalized.questions.length : 0;
  return questionCount >= 1 && questionCount <= MAX_INTERACTIVE_QUESTIONS;
}

module.exports = {
  INTERACTIVE_SEQUENCE_FALLBACK_REQUESTED,
  INTERACTIVE_SEQUENCE_IDLE,
  INTERACTIVE_SEQUENCE_STRUCTURED_ACTIVE,
  MAX_INTERACTIVE_ROUNDS,
  buildAutomaticSessionTitleCandidate,
  buildInteractiveQuestionBatchSummary,
  buildInteractiveQuestionBatchTranscript,
  buildInteractiveQuestionBatchVisibleText,
  buildInteractiveRoundRecapTranscript,
  buildInteractiveRoundRecap,
  clipTitle,
  hasValidInteractiveQuestionCount,
  isDefaultSessionTitle,
  normalizeInteractiveResponse,
  shouldApplyAutomaticSessionTitle,
};
