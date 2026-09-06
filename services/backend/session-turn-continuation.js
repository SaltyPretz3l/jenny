const { normalizeId } = require('../shared/normalize');

function isRecord(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function asGeneration(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function tokenField(token, snakeName, camelName) {
  return isRecord(token) && Object.prototype.hasOwnProperty.call(token, snakeName)
    ? token[snakeName]
    : token?.[camelName];
}

function normalizeContinuationToken(value) {
  if (!isRecord(value)) {
    return null;
  }
  return {
    token_id: normalizeId(tokenField(value, 'token_id', 'tokenId')),
    session_id: normalizeId(tokenField(value, 'session_id', 'sessionId')),
    session_incarnation: normalizeId(
      tokenField(value, 'session_incarnation', 'sessionIncarnation')
    ),
    batch_id: normalizeId(tokenField(value, 'batch_id', 'batchId')),
    prior_generation: asGeneration(
      tokenField(value, 'prior_generation', 'priorGeneration'),
      -1
    ),
    consumed: value.consumed === true,
    issued_at: normalizeId(tokenField(value, 'issued_at', 'issuedAt')),
  };
}

function getPendingQuestionBatch(session) {
  return isRecord(session?.pending_question_batch) ? session.pending_question_batch : null;
}

function getContinuationToken(session, batch = getPendingQuestionBatch(session)) {
  return normalizeContinuationToken(batch?.continuation_token || session?.continuation_token);
}

function batchFingerprint(value) {
  if (!isRecord(value)) {
    return '';
  }
  return JSON.stringify({
    batch_id: normalizeId(value.batch_id),
    round_index: Number(value.round_index) || 0,
    intro_text: normalizeId(value.intro_text),
    questions: Array.isArray(value.questions) ? value.questions : [],
  });
}

function continuationSnapshotMatches(persistedBatch, response) {
  const submittedBatch = response?.batch_snapshot || response?.batchSnapshot;
  return Boolean(
    batchFingerprint(persistedBatch)
    && batchFingerprint(persistedBatch) === batchFingerprint(submittedBatch)
  );
}

module.exports = {
  continuationSnapshotMatches,
  getContinuationToken,
  getPendingQuestionBatch,
  normalizeContinuationToken,
};
