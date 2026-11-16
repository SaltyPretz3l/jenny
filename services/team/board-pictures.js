'use strict';

// Team board pictures on a member's Jenny (row 151 slice T6, member side): one picture sent to and fetched from the
// host's picture routes (server/team/boards/board-asset-routes.js), through the live link's session.
//
// A picture is named by the SHA-256 of its bytes. Before anything is sent the bytes are checked here as the desktop's
// picture store checks them (services/boards/board-assets.js): the size, then the type and the dimensions by content
// (board-image-info.js: PNG, JPEG, WebP and GIF only). The host checks all of it again; this check saves the trip
// and gives the page the same answer shape as a local board: { ok, asset, ext, mime, width, height, bytes }.
//
// A picture that comes back is not trusted either: its bytes must hash to the name asked for and be an image of the
// type the host said, or the answer is `team_response_invalid`. Nothing is kept here and nothing is logged.

const crypto = require('node:crypto');

const { imageInfo } = require('../boards/board-image-info');
const model = require('../boards/board-model');
const { failureAnswer, invalidRequest, isFailureAnswer, teamFailure } = require('./team-errors');

const MAX_BYTES = model.LIMITS.image_asset_bytes;
// board-image-info.js's reason for a picture it does not take, as the host's own word for it.
const LOCAL_REASONS = Object.freeze({ dimensions: 'team_board_asset_dimensions', unsupported: 'team_board_asset_unsupported' });

const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const bufferOf = (value) => (ArrayBuffer.isView(value) ? Buffer.from(value.buffer, value.byteOffset, value.byteLength) : Buffer.from(value));
const invalidAnswer = () => teamFailure('CONNECTION_FAILED', 'team_response_invalid');
const refusal = (answer) => (isFailureAnswer(answer) ? failureAnswer(answer) : teamFailure('CONNECTION_FAILED', 'team_unavailable'));

/** Sends one picture (an ArrayBuffer or a typed array) for a board of the project. */
async function addPicture(link, { projectId, boardId }, value) {
  const bytes = bufferOf(value);
  if (bytes.length > MAX_BYTES) return invalidRequest('team_board_asset_size_limit');
  const info = imageInfo(bytes);
  if (!info.ok) return invalidRequest(LOCAL_REASONS[info.reason] ?? 'team_board_asset_invalid');
  const asset = sha256(bytes);
  let answer;
  try { answer = await link.session.boardAssetPut(link.client, { projectId, boardId, hash: asset, bytes }); } catch { answer = null; }
  if (answer?.ok !== true) return refusal(answer);
  // The host names what it stored; anything but this picture is not taken as stored.
  if (answer.asset !== asset || answer.type !== info.mime) return invalidAnswer();
  return { ok: true, asset, ext: info.ext, mime: info.mime, width: info.width, height: info.height, bytes: bytes.length };
}

/** Fetches one picture by its name: { ok, bytes, mime }, as the desktop's picture store answers a read. */
async function readPicture(link, { projectId, boardId }, asset) {
  let answer;
  try { answer = await link.session.boardAssetGet(link.client, { projectId, boardId, hash: asset }); } catch { answer = null; }
  if (answer?.ok !== true) return refusal(answer);
  const { bytes } = answer;
  if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > MAX_BYTES || sha256(bytes) !== asset) return invalidAnswer();
  const info = imageInfo(bytes);
  return info.ok && info.mime === answer.type ? { ok: true, bytes, mime: info.mime } : invalidAnswer();
}

module.exports = { addPicture, readPicture };
