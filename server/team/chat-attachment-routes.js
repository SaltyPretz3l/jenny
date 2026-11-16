'use strict';

// The two raw team chat attachment routes (row 123 slice 2c host, TEAM_CHAT_SPEC "Attachments"):
//
//   POST /api/v1/team/chat/uploads/<channel_id>              the body is the file; answers a staged attachment item
//   GET  /api/v1/team/chat/attachments/<channel_id>/<att_id> an attached file of a visible message in that channel
//
// The upload's name travels percent-encoded in `x-file-name`, its type in `Content-Type`; `Content-Length` is
// required and at most 4 MiB. The guard runs with the explicit action (`chat.write`, `chat.read`) on the channel
// before the body or the read, again after it, and again after the write; a channel the caller cannot see and
// one that does not exist answer the same `team_chat_not_found`. The free refusals (archived, blocked uploads, the
// staged cap, the headers, then the disk gate) come before a byte of the body is read. Refusals before the body
// drain it while its declared length is at most twice the cap and stop otherwise (raw-route-body.js). At most four
// uploads per member are in flight (`team_upload_limit`, retryable). A download is always `attachment`,
// `no-store` and `nosniff`; its type is the stored one only for a checked image. Logs carry the route word and a
// reason only: never a file name or a byte.

const { hostFailure } = require('../api-contract');
const { downloadDisposition } = require('../download-headers');
const { json } = require('../http-server');
const { createDiskAdmission } = require('../resource-limits');
const rawBody = require('./raw-route-body');
const { routeDenial } = require('./route-guard');
const { safeLogger } = require('./safe-logger');
const { LIMITS, PATTERNS, channelKind } = require('../../services/host/team-chat-schema');
const { isFileName, isMime } = require('../../services/host/team-chat-blobs');

const UPLOAD_ACTION = 'chat.write';
const DOWNLOAD_ACTION = 'chat.read';
const UPLOAD_PATH = /^\/api\/v1\/team\/chat\/uploads\/([^/]{1,200})$/u;
const DOWNLOAD_PATH = /^\/api\/v1\/team\/chat\/attachments\/([^/]{1,200})\/([^/]{1,200})$/u;
const CAP = LIMITS.ATTACHMENT_MAX_BYTES;
const IN_FLIGHT_PER_MEMBER = 4;
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);

const notFound = () => hostFailure('forbidden', 'team_chat_not_found');

// The decoded `x-file-name`, or null (missing, not percent-decodable, or not a name the message may store).
function fileName(headers) {
  const raw = headers?.['x-file-name'];
  if (typeof raw !== 'string') return null;
  let name;
  try { name = decodeURIComponent(raw); } catch { return null; }
  return isFileName(name) ? name : null;
}

const typeOf = (headers) => String(headers?.['content-type'] || '').split(';', 1)[0].trim().toLowerCase();

// chat(): the team chat host's `attachments` (team-chat-host.js), read lazily. `canAdmit` is the disk gate; by
// default the host core's own rule on the same roots (`diskRoots`, `statfs` for tests).
function createChatAttachmentRoutes({ chat, logger = null, diskRoots = [], canAdmit = null, statfs } = {}) {
  if (typeof chat !== 'function') throw new TypeError('Chat attachment routes need the chat host.');
  const log = safeLogger(logger);
  const admit = typeof canAdmit === 'function' ? canAdmit
    : createDiskAdmission(diskRoots, { logger: log, ...(statfs ? { statfs } : {}) });
  const hold = rawBody.createInFlight(IN_FLIGHT_PER_MEMBER);
  const refuse = rawBody.createRefuser(log, 'team.chat_attachments.route_refused');
  const early = (ctx, failure) => refuse(ctx, failure, { close: true, body: rawBody.bodyRule(ctx, CAP) });

  // null while the caller may still act on the channel and the channel exists, else the refusal.
  function check(ctx, action, channelId) {
    if (!rawBody.authorized(ctx)) return hostFailure('forbidden', 'client_required');
    const attachments = chat()?.attachments;
    if (!attachments) return hostFailure('persistence', 'team_chat_store_failed');
    const down = attachments.unavailable();
    if (down) return down;
    const denied = routeDenial(ctx, action, { kind: 'channel', id: channelId }, { guardRequired: true });
    if (denied) return denied;
    const header = attachments.channelHeader(channelId);
    return header.ok ? null : header;
  }

  // The refusals that cost nothing: before a byte of the body is read.
  function beforeBody(ctx, channelId) {
    const before = check(ctx, UPLOAD_ACTION, channelId);
    if (before) return { failure: before };
    const pre = chat().attachments.precheck(channelId, ctx.actor?.member_id);
    if (!pre.ok) return { failure: pre };
    const headers = ctx.request.headers || {};
    const declaredText = headers['content-length'];
    if (typeof declaredText !== 'string' || !rawBody.LENGTH.test(declaredText) || Number(declaredText) === 0) {
      return { failure: hostFailure('invalid', 'team_chat_request_invalid') };
    }
    const declared = Number(declaredText);
    if (declared > CAP) return { failure: hostFailure('limit', 'attachment_size_limit') };
    const name = fileName(headers);
    if (name === null) return { failure: hostFailure('invalid', 'display_name_invalid') };
    const mime = typeOf(headers);
    if (!isMime(mime)) return { failure: hostFailure('invalid', 'mime_type_unsupported') };
    if (admit() !== true) return { failure: hostFailure('unavailable', 'disk_pressure', '', true) };
    return { declared, name, mime };
  }

  async function upload(ctx, channelId) {
    const ready = beforeBody(ctx, channelId);
    if (ready.failure) return early(ctx, ready.failure);
    const bytes = await rawBody.readExactly(ctx.request, ready.declared);
    if (!bytes) return refuse(ctx, hostFailure('limit', 'attachment_size_limit'), { close: true });
    // Removed, re-roled, revoked or dropped while the body arrived: refused, and nothing is staged.
    const after = check(ctx, UPLOAD_ACTION, channelId);
    if (after) return refuse(ctx, after);
    const staged = await chat().attachments.stage({ channelId, memberId: ctx.actor?.member_id, name: ready.name,
      mime: ready.mime, bytes });
    if (!staged.ok) return refuse(ctx, staged);
    const late = check(ctx, UPLOAD_ACTION, channelId);
    if (late) {
      chat()?.attachments?.discard(staged.attachment.id);
      return refuse(ctx, late);
    }
    json(ctx.response, 200, { ok: true, attachment: staged.attachment });
    return true;
  }

  async function download(ctx, channelId, attachmentId) {
    const before = check(ctx, DOWNLOAD_ACTION, channelId);
    if (before) return refuse(ctx, before);
    if (!PATTERNS.attachment.test(attachmentId)) return refuse(ctx, notFound());
    const read = await chat().attachments.read(channelId, attachmentId);
    // The read awaited: the caller is checked again before the first byte goes out.
    const after = check(ctx, DOWNLOAD_ACTION, channelId);
    if (after) return refuse(ctx, after);
    if (!read.ok) return refuse(ctx, read);
    const { attachment, bytes } = read;
    const image = attachment.kind === 'image' && IMAGE_TYPES.has(attachment.mime);
    ctx.response.writeHead(200, { 'Content-Type': image ? attachment.mime : 'application/octet-stream',
      'Content-Length': bytes.length, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
      'Content-Disposition': downloadDisposition(attachment.name) });
    ctx.response.end(bytes);
    return true;
  }

  return async function chatAttachmentRoutes(ctx = {}) {
    const pathname = String(ctx.pathname || '');
    const method = String(ctx.request?.method || '').toUpperCase();
    const uploadMatch = method === 'POST' ? UPLOAD_PATH.exec(pathname) : null;
    const downloadMatch = method === 'GET' ? DOWNLOAD_PATH.exec(pathname) : null;
    if (!uploadMatch && !downloadMatch) return false;
    const refuseFirst = (failure) => (uploadMatch ? early(ctx, failure) : refuse(ctx, failure));
    try {
      if (!rawBody.authorized(ctx)) return refuseFirst(hostFailure('forbidden', 'client_required'));
      const channelId = (uploadMatch || downloadMatch)[1];
      if (channelKind(channelId) === null) return refuseFirst(notFound());
      if (downloadMatch) return await download(ctx, channelId, downloadMatch[2]);
      return await hold(ctx.actor?.member_id, () => early(ctx, hostFailure('limit', 'team_upload_limit', '', true)),
        () => upload(ctx, channelId));
    } catch {
      log('WARN', 'team.chat_attachments.route_failed', {});
      if (ctx.response?.headersSent) ctx.response.destroy();
      else refuse(ctx, hostFailure('unavailable', 'host_unavailable'), { close: true });
      return true;
    }
  };
}

module.exports = { createChatAttachmentRoutes };
