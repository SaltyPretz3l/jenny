'use strict';

// The two raw node routes (slice 4c host; spec "4c host as built"):
//
//   GET  /api/v1/team/node/jobs/<job_id>/request  the claimed job's request bytes
//   POST /api/v1/team/node/jobs/<job_id>/chunks   one bounded piece of the reply
//
// A job id is honoured only for the caller's device's node; every other one answers
// job_not_found byte for byte the same. The member is checked again after the chunk
// body is read, since a body may take until the request timeout to arrive.

const { hostFailure } = require('../api-contract');
const { STATUS_BY_CODE, json } = require('../http-server');
const { memberRouteDenial, TEAM_RESOURCE } = require('./engine-routes');
const { NODE_SHARE_ACTION, ownNode } = require('./node-commands');
const { readBody } = require('./pool-gateway');
const { safeLogger } = require('./safe-logger');

const NODE_PREFIX = '/api/v1/team/node/';
const JOB_PATH = /^\/api\/v1\/team\/node\/jobs\/([^/]{1,200})\/(request|chunks)$/u;
const JOB_ID = /^job_[A-Za-z0-9_-]{1,128}$/u;
const SEQ = /^(0|[1-9][0-9]{0,15})$/u;

const jobNotFound = () => hostFailure('forbidden', 'job_not_found');
const rateLimited = () => hostFailure('limit', 'node_rate_limit');

// `pool()` answers the pool composition or null; only its `scheduler` is used. `rates`
// is the node rate limit node-commands.js builds (createNodeRates), shared with it.
function createNodeRoutes({ pool = () => null, rates, logger = null } = {}) {
  if (typeof pool !== 'function') throw new TypeError('Node routes need a pool reader.');
  if (!rates || typeof rates.take !== 'function') throw new TypeError('Node routes need node rates.');
  const log = safeLogger(logger);

  // A refusal: the body is drained, never buffered.
  function refuse(ctx, failure, extra = {}) {
    ctx.request.resume();
    json(ctx.response, STATUS_BY_CODE[failure.error.code] || 503, { ...failure, ...extra });
    log('INFO', 'team.node.route_refused', { reason: failure.error.reason });
  }

  function schedulerOf() {
    let current;
    try { current = pool(); } catch (_error) { current = null; }
    return current && current.scheduler && typeof current.scheduler.jobRequest === 'function' ? current.scheduler : null;
  }

  // The scheduler refuses a job over `limits.maxRequestBytes` (8 MiB) at `createJob`, so a
  // claimed job's request always fits the answer.
  function serveRequest(ctx, scheduler, node, jobId) {
    ctx.request.resume();
    if (!rates.take('claim', node.node_id, node.slots)) { refuse(ctx, rateLimited()); return; }
    const found = scheduler.jobRequest(jobId, node.node_id);
    if (!found.ok) { refuse(ctx, jobNotFound()); return; }
    ctx.response.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': found.request.length,
      'Cache-Control': 'no-store' });
    ctx.response.end(found.request);
    log('INFO', 'team.node.request_sent', { job_id: jobId, node_id: node.node_id, bytes: found.request.length });
  }

  async function serveChunk(ctx, scheduler, node, jobId) {
    const { headers } = ctx.request;
    if (!rates.take('chunk', node.node_id, node.slots)) { refuse(ctx, rateLimited()); return; }
    const seqText = headers['x-chunk-seq'];
    const finalText = headers['x-chunk-final'];
    if (typeof seqText !== 'string' || !SEQ.test(seqText) || !Number.isSafeInteger(Number(seqText))
      || (finalText !== '0' && finalText !== '1')) {
      refuse(ctx, hostFailure('invalid', 'node_protocol_invalid'));
      return;
    }
    const read = await readBody(ctx.request, scheduler.limits.maxChunkBytes);
    if (!read.ok) {
      if (read.reason === 'too_large') refuse(ctx, hostFailure('invalid', 'node_chunk_too_large'));
      return; // aborted: the socket is gone
    }
    // Revoked, demoted or unregistered while the body arrived: refused, and nothing is accepted.
    const denied = memberRouteDenial(ctx, NODE_SHARE_ACTION, TEAM_RESOURCE);
    if (denied) { refuse(ctx, denied); return; }
    if (scheduler.nodeIdForDevice(ctx.deviceId) !== node.node_id) { refuse(ctx, jobNotFound()); return; }
    const accepted = scheduler.acceptChunk(jobId, node.node_id, Number(seqText), read.body, finalText === '1');
    if (accepted.ok) {
      json(ctx.response, 200, { ok: true, next_seq: accepted.next_seq, cancel: accepted.cancel === true });
      if (finalText === '1' || accepted.cancel) {
        log('INFO', 'team.node.chunk_final', { job_id: jobId, node_id: node.node_id, next_seq: accepted.next_seq,
          cancel: accepted.cancel === true });
      }
      return;
    }
    if (accepted.error) {
      refuse(ctx, accepted, accepted.error.reason === 'node_chunk_seq_invalid' ? { next_seq: accepted.next_seq } : {});
      return;
    }
    // A bare refusal: this node's job the gateway side cancelled answers cancel; any other is not found.
    const job = scheduler.getJob(jobId);
    if (job && job.node_id === node.node_id && job.state === 'cancelled') {
      json(ctx.response, 200, { ok: true, next_seq: job.next_seq, cancel: true });
      return;
    }
    refuse(ctx, jobNotFound());
  }

  return async function handle(ctx = {}) {
    const pathname = String(ctx.pathname || '');
    if (!pathname.startsWith(NODE_PREFIX)) return null;
    const match = JOB_PATH.exec(pathname);
    const method = String(ctx.request?.method || '').toUpperCase();
    if (!match || method !== (match[2] === 'request' ? 'GET' : 'POST')) return null;
    try {
      const denied = memberRouteDenial(ctx, NODE_SHARE_ACTION, TEAM_RESOURCE);
      if (denied) { refuse(ctx, denied); return true; }
      if (typeof ctx.deviceId !== 'string' || ctx.deviceId !== ctx.actor.device_id) {
        refuse(ctx, hostFailure('forbidden', 'role_forbidden'));
        return true;
      }
      const scheduler = schedulerOf();
      if (!scheduler) { refuse(ctx, hostFailure('unavailable', 'team_pool_unavailable')); return true; }
      const node = ownNode(scheduler, ctx.deviceId);
      const jobId = match[1];
      if (!node || !JOB_ID.test(jobId)) { refuse(ctx, jobNotFound()); return true; }
      if (match[2] === 'request') serveRequest(ctx, scheduler, node, jobId);
      else await serveChunk(ctx, scheduler, node, jobId);
    } catch (_error) {
      log('WARN', 'team.node.route_failed', {});
      if (ctx.response?.headersSent) ctx.response.destroy();
      else refuse(ctx, hostFailure('unavailable', 'team_pool_unavailable'));
    }
    return true;
  };
}

module.exports = { createNodeRoutes };
