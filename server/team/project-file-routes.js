'use strict';

// The two raw part routes of a team project's files (TEAM_PROJECTS_SPEC "Upload and download", slice 3-8b):
//
//   PUT /api/v1/projects/<project_id>/uploads/<upload_id>/files/<index>/parts/<n>      one part of an upload
//   GET /api/v1/projects/<project_id>/downloads/<manifest_id>/files/<index>/parts/<n>  one part of a listed file
//
// Part `n` is the bytes at offset `n * part_size`. The guard runs with the explicit action before the body
// (or before the read) and again after it, before the write or the first byte out; the upload or manifest id
// is checked against the caller's member, device and the path's project each time. A forged or foreign id,
// index or part answers as a missing one. A part body is at most the upload's part size: a larger
// Content-Length is refused before a byte is read, and a body that runs past its Content-Length is refused
// while it is read. Every PUT refusal made before the body is read closes the connection. While the declared
// length is at most twice the part cap the body is drained and the answer sent at its end: answering while the
// client still sends makes Node close on unread data, which on Windows resets the connection and loses the
// answer. Past that the answer goes at once and nothing is read. At most four part requests per member are in flight on each route
// (`team_upload_limit`, retryable). The part routes do not take the team command limiter's tokens (decision 14).
// Logs carry the route word and a reason only.

const { hostFailure } = require('../api-contract');
const { json } = require('../http-server');
const { PROJECT_ID_PATTERN } = require('./member-schema');
const { LENGTH, authorized, bodyRule, createInFlight, createRefuser, readExactly } = require('./raw-route-body');
const { routeDenial } = require('./route-guard');
const { safeLogger } = require('./safe-logger');
const { TRANSFER_LIMITS } = require('./transfer-manifest');

const UPLOAD_ACTION = 'project.files.upload';
const DOWNLOAD_ACTION = 'project.files.download';
const PART_PATH = /^\/api\/v1\/projects\/([^/]{1,200})\/(uploads|downloads)\/([^/]{1,200})\/files\/([^/]{1,24})\/parts\/([^/]{1,24})$/u;
const NUMBER = /^(0|[1-9][0-9]{0,8})$/u;
const IN_FLIGHT_PER_MEMBER = 4;

const notFound = () => hostFailure('forbidden', 'team_not_found');

// files(): project-files.js as it stands now (its route half).
function createProjectFileRoutes({ files, logger = null } = {}) {
  if (typeof files !== 'function') throw new TypeError('Project file routes need the project files module.');
  const log = safeLogger(logger);
  const hold = createInFlight(IN_FLIGHT_PER_MEMBER);
  // The shared refusal (raw-route-body.js): drains or stops a body not yet read.
  const refuse = createRefuser(log, 'team.project_files.route_refused');

  // null while the caller may still act on this project, else the refusal. Run before and after every wait.
  function check(ctx, action, projectId) {
    if (!authorized(ctx)) return hostFailure('forbidden', 'client_required');
    return routeDenial(ctx, action, { kind: 'project', id: projectId }, { guardRequired: true })
      || files().projectGate(projectId);
  }

  async function putPart(ctx, projectId, uploadId, index, n) {
    const caller = [ctx.actor?.member_id, ctx.deviceId, projectId];
    const found = files().uploadFor(uploadId, ...caller);
    const cap = found.record?.partSize ?? TRANSFER_LIMITS.maxPartBytes;
    const early = (failure) => refuse(ctx, failure, { close: true, body: bodyRule(ctx, cap) });
    if (found.failure) return early(found.failure);
    const declaredText = ctx.request.headers?.['content-length'];
    if (typeof declaredText !== 'string' || !LENGTH.test(declaredText) || Number(declaredText) === 0) {
      return early(hostFailure('invalid', 'team_upload_manifest_invalid'));
    }
    const declared = Number(declaredText);
    if (declared > cap) return early(hostFailure('limit', 'team_upload_size_limit'));
    const body = await readExactly(ctx.request, declared);
    if (!body) return refuse(ctx, hostFailure('limit', 'team_upload_size_limit'), { close: true });
    // Removed, re-roled, revoked or dropped while the body arrived: refused, and nothing is written.
    const after = check(ctx, UPLOAD_ACTION, projectId);
    if (after) return refuse(ctx, after);
    const again = files().uploadFor(uploadId, ...caller);
    if (again.failure || again.record !== found.record) return refuse(ctx, again.failure || notFound());
    const written = await files().writePart(found.record, index, n, body);
    const late = check(ctx, UPLOAD_ACTION, projectId);
    if (late) return refuse(ctx, late);
    if (!written.ok) return refuse(ctx, written);
    json(ctx.response, 200, written);
    return true;
  }

  async function getPart(ctx, projectId, manifestId, index, n) {
    const caller = [ctx.actor?.member_id, ctx.deviceId, projectId];
    const manifest = files().manifestFor(manifestId, ...caller);
    if (!manifest) return refuse(ctx, notFound());
    const read = await files().readPart(manifest, index, n);
    // The read awaited: the caller and the manifest are checked again before the first byte goes out.
    const after = check(ctx, DOWNLOAD_ACTION, projectId);
    if (after) return refuse(ctx, after);
    if (files().manifestFor(manifestId, ...caller) !== manifest) return refuse(ctx, notFound());
    if (!read.ok) return refuse(ctx, read);
    ctx.response.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': read.bytes.length,
      'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    ctx.response.end(read.bytes);
    return true;
  }

  // Runs `work` holding one of the member's in-flight slots on this route, or refuses when all four are held.
  function holding(ctx, action, work) {
    const full = () => {
      const failure = hostFailure('limit', 'team_upload_limit', '', true);
      return action === UPLOAD_ACTION
        ? refuse(ctx, failure, { close: true, body: bodyRule(ctx, TRANSFER_LIMITS.maxPartBytes) }) : refuse(ctx, failure);
    };
    return hold(`${action}\u0000${ctx.actor?.member_id}`, full, work);
  }

  return async function projectFileRoutes(ctx = {}) {
    const match = PART_PATH.exec(String(ctx.pathname || ''));
    const method = String(ctx.request?.method || '').toUpperCase();
    if (!match || method !== (match[2] === 'uploads' ? 'PUT' : 'GET')) return false;
    const action = match[2] === 'uploads' ? UPLOAD_ACTION : DOWNLOAD_ACTION;
    // Before the body: a PUT closes and drains or stops; a GET has no body to wait for.
    const early = (failure) => (action === UPLOAD_ACTION
      ? refuse(ctx, failure, { close: true, body: bodyRule(ctx, TRANSFER_LIMITS.maxPartBytes) }) : refuse(ctx, failure));
    try {
      if (!authorized(ctx)) return early(hostFailure('forbidden', 'client_required'));
      const unavailable = files().filesUnavailable();
      if (unavailable) return early(unavailable);
      const [, projectId, , id, indexText, partText] = match;
      if (!PROJECT_ID_PATTERN.test(projectId)) return early(notFound());
      const before = check(ctx, action, projectId);
      if (before) return early(before);
      if (!NUMBER.test(indexText) || !NUMBER.test(partText)) return early(notFound());
      const index = Number(indexText);
      const n = Number(partText);
      return await holding(ctx, action, () => (action === UPLOAD_ACTION ? putPart(ctx, projectId, id, index, n)
        : getPart(ctx, projectId, id, index, n)));
    } catch {
      log('WARN', 'team.project_files.route_failed', {});
      if (ctx.response?.headersSent) ctx.response.destroy();
      else refuse(ctx, hostFailure('unavailable', 'host_unavailable'), { close: true });
      return true;
    }
  };
}

module.exports = { createProjectFileRoutes };
