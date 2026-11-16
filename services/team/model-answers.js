'use strict';

// The host's model sharing answers and events on the member side (row 123 slice 6-5), rebuilt field by field before
// anything uses them (the E49 rule, admin-answers.js): an offer summary, a transfer view, an offer with its manifest.
// A value that does not pass is BAD and dropped, never passed on; a row's reason word this client does not know is
// kept as `team_unavailable`. A failure keeps the host's code and only a reason word from the closed list
// (model-reasons.js). No state, no I/O.

const { isId } = require('../../server/team/ids');
const { isCleanText } = require('../../server/team/member-schema');
const { MODEL_TRANSFER_LIMITS, validateModelManifest } = require('../../server/team/model-manifest');
const { MODEL_RELAY_ID_PATTERNS } = require('../../server/team/model-relay-core');
const { BAD, count, fields, flag, is, nullable, oneOf, optional } = require('./answer-rules');
const { MODEL_REASONS, rowReason } = require('./model-reasons');
const { failureAnswer } = require('./team-errors');

const offerId = is((value) => typeof value === 'string' && MODEL_RELAY_ID_PATTERNS.offer.test(value));
const transferId = is((value) => typeof value === 'string' && MODEL_RELAY_ID_PATTERNS.transfer.test(value));
const memberId = is((value) => isId('member', value));
const displayName = is((value) => isCleanText(value, MODEL_TRANSFER_LIMITS.maxDisplayNameChars));
// A reason word this client does not know (a newer host's) keeps the row as `team_unavailable`, never drops it.
const reason = (value) => {
  if (value === null) return null;
  if (typeof value !== 'string' || value.length > 64) return BAD;
  return rowReason(value) ?? 'team_unavailable';
};
const fileCount = is((value) => Number.isSafeInteger(value) && value >= 1 && value <= MODEL_TRANSFER_LIMITS.maxFiles);
const next = nullable((value) => fields(value, {
  index: is((index) => Number.isSafeInteger(index) && index >= 0 && index < MODEL_TRANSFER_LIMITS.maxFiles),
  part: count,
}));

const SUMMARY = {
  offer_id: offerId, sender_member_id: memberId, audience: oneOf(['member', 'team']), display_name: displayName,
  files: fileCount, total_bytes: count, state: oneOf(['open', 'taken', 'ended']), reason: optional(reason),
};
const VIEW = {
  transfer_id: transferId, offer_id: offerId, sender_member_id: memberId, receiver_member_id: memberId,
  state: oneOf(['accepted', 'flowing', 'paused', 'done', 'failed', 'cancelled', 'forgotten']), queued: flag,
  reason, display_name: displayName, bytes_done: count, bytes_total: count, next,
};

/** An offer summary (an answer's or a `team_model_offer` event's), or null. */
function offerSummary(value) {
  const checked = fields(value, SUMMARY);
  if (checked === BAD) return null;
  return { ...checked, reason: checked.reason ?? null };
}

/** A transfer view (an answer's or a `team_model_transfer` event's), or null. */
function transferView(value) {
  const checked = fields(value, VIEW);
  return checked === BAD || checked.bytes_done > checked.bytes_total ? null : checked;
}

/** `team.model.offer.read`'s answer: { summary, manifest } with the manifest re-validated by 6-1's module, or null. */
function offerWithManifest(answer) {
  if (answer?.ok !== true) return null;
  const summary = offerSummary(answer.offer);
  const checked = validateModelManifest(answer.manifest);
  if (!summary || !checked.ok) return null;
  const total = checked.manifest.files.reduce((sum, file) => sum + file.size, 0);
  return total === summary.total_bytes && checked.manifest.files.length === summary.files
    ? { summary, manifest: checked.manifest } : null;
}

/** `team.model.offers`'s answer: { offers, transfers } keeping only the rows that pass, or null for a bad answer. */
function offersList(answer) {
  if (answer?.ok !== true || !Array.isArray(answer.offers) || !Array.isArray(answer.transfers)) return null;
  if (answer.offers.length > MODEL_TRANSFER_LIMITS.maxOffersPerHost
    || answer.transfers.length > MODEL_TRANSFER_LIMITS.maxTransferRecords) return null;
  return {
    offers: answer.offers.map(offerSummary).filter(Boolean),
    transfers: answer.transfers.map(transferView).filter(Boolean),
  };
}

/** A failure as a model method answers it: the host's code, and a closed reason word or `team_unavailable`. */
function modelFailure(answer) {
  const rebuilt = failureAnswer(answer);
  if (!MODEL_REASONS.includes(rebuilt.error.reason)) rebuilt.error.reason = 'team_unavailable';
  return rebuilt;
}

module.exports = { modelFailure, offerSummary, offerWithManifest, offersList, transferView };
