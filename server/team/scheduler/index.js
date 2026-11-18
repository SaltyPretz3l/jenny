'use strict';

// The team pool scheduler facade (row 123, slice 4a-1). Pure: no HTTP, no
// timers, no I/O; the clock and random bytes are injected. Time-based changes
// happen only inside sweep(now). Every mutating call decides first (all
// refusals), then mutates, then notifies job watchers and the change feed.
// The route token is never logged, never in an error and never in a listing.

const { hostFailure } = require('../../api-contract');
const { isId } = require('../ids');
const { safeLogger } = require('../safe-logger');
const { createAffinityMap, createExclusions } = require('./affinity');
const { createFeed } = require('./feed');
const {
  JOB_LIVE, JOB_RUNNING, JOB_TERMINAL, claimDescriptor, createJobTable, jobView, scanChunk,
} = require('./jobs');
const { CANCEL_REASONS, NODE_FAIL_REASONS, NON_EXCLUDING_REASONS, resolveLimits } = require('./limits');
const { orderWaiting } = require('./queue');
const { chooseNode, isEligible, modelEntry, onlineSlots, poolSummary } = require('./selection');
const {
  createLeaseTable, createMemberServed, createNodeTable, isPrintable, leaseView, nodeView, normalizeAllowedNodes,
} = require('./state');

const BARE_REFUSAL = Object.freeze({ ok: false });

function createPoolScheduler({ clock, randomBytes, limits: overrides, logger } = {}) {
  if (typeof clock !== 'function') throw new TypeError('Pool scheduler requires a clock function.');
  if (typeof randomBytes !== 'function') throw new TypeError('Pool scheduler requires a randomBytes function.');
  const limits = resolveLimits(overrides);
  const log = safeLogger(logger);
  const nodes = createNodeTable({ limits });
  const leases = createLeaseTable({ limits, randomBytes });
  const jobs = createJobTable({ limits, randomBytes });
  const affinity = createAffinityMap({ max: limits.affinityMax, idleMs: limits.affinityIdleMs });
  const exclusions = createExclusions({ max: limits.exclusionMax, ttlMs: limits.exclusionMs });
  const feed = createFeed({ maxListeners: limits.maxListeners, log });
  const served = createMemberServed({ max: limits.maxMembers }); // when each member was last served

  // -------------------------------------------------------------------------
  // Reads.

  const busySlots = (nodeId) => leases.all().filter((l) => l.state === 'active' && l.node_id === nodeId).length;
  const nodeViews = () => nodes.all().map((node) => nodeView(node, busySlots(node.node_id)));
  // The one wait order for the queue positions and for dispatch: turns by member, least recently served first.
  // With a single registered node the positions also follow that node's tiers (its owner, the E52 hold-back), as
  // dispatch does; with several nodes there is no single order, so positions use the pool-wide rule.
  const queuedLeases = () => {
    const all = nodes.all();
    const only = all.length === 1 ? all[0] : null;
    return orderWaiting(leases.all().filter((l) => l.state === 'queued'), only, only?.owner_went_ahead, served.rank);
  };
  const liveJob = (lease) => {
    const job = lease.live_job_id ? jobs.get(lease.live_job_id) : null;
    return job && JOB_LIVE.has(job.state) ? job : null;
  };
  const viewLease = (record) => leaseView(record, record.state === 'queued' ? queuedLeases().indexOf(record) + 1 : null);
  const want = (lease, now) => ({
    model: lease.model, wantsVision: lease.wants_vision, allowedNodes: lease.allowed_nodes,
    affinityNodeId: affinity.get(lease.conversation_key, now),
    excludedNodeId: exclusions.get(lease.conversation_key, now),
  });

  // -------------------------------------------------------------------------
  // Mutation helpers. A batch collects one call's transitions and effects;
  // `dirty` marks a change that can move the queue positions or the slots.

  const newBatch = () => ({ transitions: [], effects: [], dirty: false });

  // `exclude: false`: the end is no fault of the node's work (R16-F02, a job it never claimed).
  function moveLease(batch, lease, from, to, trigger, reason, now, { exclude = true } = {}) {
    const result = leases.transition(lease, from, to, trigger, reason, now);
    if (!result.ok) {
      log('warn', 'team.pool.transition_refused', { table: 'lease', id: lease.lease_id, from, to, trigger });
      return false;
    }
    batch.transitions.push({ ...result.transition, id: lease.lease_id, lease });
    batch.dirty = true;
    if (exclude && (to === 'failed' || to === 'expired') && lease.node_id && !NON_EXCLUDING_REASONS.has(lease.reason)) {
      exclusions.exclude(lease.conversation_key, lease.node_id, now);
    }
    return true;
  }

  function moveJob(batch, job, from, to, trigger, reason, now) {
    const result = jobs.transition(job, from, to, trigger, reason, now);
    if (!result.ok) {
      log('warn', 'team.pool.transition_refused', { table: 'job', id: job.job_id, from, to, trigger });
      return false;
    }
    batch.transitions.push({ ...result.transition, id: job.job_id, job });
    batch.dirty = true;
    if (JOB_TERMINAL.has(to)) {
      const lease = leases.get(job.lease_id);
      if (lease && lease.live_job_id === job.job_id) Object.assign(lease, { live_job_id: null, last_job_at: now });
      const end = { type: 'end', state: to, reason: job.reason };
      batch.effects.push(() => notify(job, end));
    }
    return true;
  }

  function notify(job, event) {
    for (const watcher of [...job.watchers]) {
      try { watcher(event); } catch (_error) { log('warn', 'team.pool.watcher_failed', { job_id: job.job_id }); }
    }
    if (event.type === 'end') job.watchers = [];
  }

  // A running job fails, and so does its lease.
  function failRunning(batch, job, trigger, reason, now) {
    moveJob(batch, job, job.state, 'failed', trigger, reason, now);
    const lease = leases.get(job.lease_id);
    if (lease && lease.state === 'active') moveLease(batch, lease, 'active', 'failed', 'job_failed', reason, now);
  }

  // Ends an active lease: its live job first, then the lease itself.
  function endActiveLease(batch, lease, { to, trigger, reason, runningJob, exclude = true }, now) {
    const job = liveJob(lease);
    if (job && job.state === 'queued') moveJob(batch, job, 'queued', 'failed', 'lease_terminal', reason, now);
    else if (job) moveJob(batch, job, job.state, runningJob.to, runningJob.trigger, reason, now);
    moveLease(batch, lease, 'active', to, trigger, reason, now, { exclude });
  }

  const stopLease = (batch, lease, now) => endActiveLease(batch, lease, {
    to: 'failed', trigger: 'node_stopped', reason: 'user_stopped_sharing',
    runningJob: { to: 'failed', trigger: 'node_stopped' },
  }, now);

  // R16-F02: a paused node (its owner's own work, or a pause) takes no new job: a lease with no running
  // job there ends at once with node_busy, which excludes nothing, instead of waiting out a claim.
  const busyLease = (batch, lease, now) => endActiveLease(batch, lease, {
    to: 'failed', trigger: 'node_stopped', reason: 'node_busy', runningJob: null, exclude: false,
  }, now);

  function contact(batch, node, now) {
    nodes.setNodeFields(node, { last_contact_at: now });
    if (!node.online) {
      nodes.setNodeFields(node, { online: true, offline_at: null });
      batch.dirty = true;
      dispatch(batch, now);
    }
  }

  // Transition first, then the node fields, so a refused or throwing
  // transition (the token mint) leaves the queued lease untouched.
  function activate(batch, lease, node, now) {
    const entry = modelEntry(node, lease.model);
    if (!moveLease(batch, lease, 'queued', 'active', 'node_assigned', null, now)) return false;
    Object.assign(lease, { node_id: node.node_id, model_info: { ...entry } });
    nodes.setNodeFields(node, { last_served_at: now });
    served.mark(lease.member_id);
    affinity.set(lease.conversation_key, node.node_id, now);
    return true;
  }

  // Gives free slots to waiting leases: each waiting lease's choice is computed
  // once; then, for the free nodes oldest served first, the first lease in the
  // wait order for that node whose choice is that node. Repeats until nothing
  // moves. Bounded by the queue and slot limits.
  function dispatch(batch, now) {
    for (;;) {
      const waiting = leases.all().filter((l) => l.state === 'queued');
      if (waiting.length === 0) return;
      const views = nodeViews().sort((a, b) => a.last_served_at - b.last_served_at || a.order - b.order);
      const choices = new Map(waiting.map((lease) => {
        const w = want(lease, now);
        return [lease, chooseNode(views, w, w)?.node_id ?? null];
      }));
      let moved = false;
      for (const view of views) {
        if (!view.online || view.paused || view.busy_slots >= view.slots) continue;
        const mine = waiting.filter((lease) => choices.get(lease) === view.node_id);
        if (mine.length === 0) continue;
        const node = nodes.get(view.node_id);
        const chosen = orderWaiting(mine, node, node.owner_went_ahead, served.rank)[0];
        // E52: remember whether this turn went to the owner while another member waited here.
        if (activate(batch, chosen, node, now)) {
          nodes.setNodeFields(node, { owner_went_ahead: chosen.member_id === node.member_id
            && mine.some((lease) => lease.member_id !== node.member_id) });
        }
        moved = true;
        break;
      }
      if (!moved) return;
    }
  }

  function finish(batch) {
    for (const effect of batch.effects) effect();
    const all = nodes.all();
    feed.publish(batch.transitions, batch.dirty ? {
      positions: queuedLeases().map((l, i) => ({
        lease_id: l.lease_id, conversation_key: l.conversation_key, member_id: l.member_id, position: i + 1 })),
      onlineSlots: onlineSlots(all), nodeCount: all.length,
    } : null);
    return batch.transitions.map(({ table, id, from, to, trigger, reason }) => ({ table, id, from, to, trigger, reason }));
  }

  // The one "clock, batch, change, finish" wrapper for every mutating call.
  function mutate(change, now = clock()) {
    const batch = newBatch();
    const result = change(batch, now);
    finish(batch);
    return result;
  }

  const fail = (kind, reason) => hostFailure(kind, reason);

  // -------------------------------------------------------------------------
  // Nodes.

  function registerNode(input = {}) {
    const plan = nodes.planRegister(input);
    if (!plan.ok) return fail(plan.kind, plan.reason);
    return mutate((batch, now) => {
      const node = nodes.applyRegister(plan, input, now);
      batch.dirty = true;
      dispatch(batch, now);
      return { ok: true, node_id: node.node_id };
    });
  }

  function withNode(nodeId, change) {
    const node = nodes.get(nodeId);
    if (!node) return fail('forbidden', 'node_not_found');
    return mutate((batch, now) => change(node, batch, now));
  }

  const activeOn = (node) => leases.all().filter((lease) => lease.state === 'active' && lease.node_id === node.node_id);

  // A pause is the node speaking, so it counts as contact (R16-F02: the agent repeats it each heartbeat
  // while its owner's own work runs). Without stop, a lease whose job is not yet claimed ends node_busy.
  // E76: `ownerBusy` says the pause is the member's own work (the list then says "in use by its owner"); it changes
  // the word the list shows and nothing else: a paused node takes no job either way.
  function setNodePaused(nodeId, { on, stopRunning = false, ownerBusy = false } = {}) {
    if (typeof on !== 'boolean' || typeof stopRunning !== 'boolean' || typeof ownerBusy !== 'boolean') return fail('invalid', 'node_protocol_invalid');
    return withNode(nodeId, (node, batch, now) => {
      nodes.setNodeFields(node, { paused: on, owner_busy: on && ownerBusy });
      batch.dirty = true;
      contact(batch, node, now);
      if (on && stopRunning) for (const lease of activeOn(node)) stopLease(batch, lease, now);
      else if (on) for (const lease of activeOn(node)) if (liveJob(lease)?.state === 'queued') busyLease(batch, lease, now);
      dispatch(batch, now);
      return { ok: true, node: nodeView(node, busySlots(node.node_id)) };
    });
  }

  function removeNode(batch, node) {
    nodes.remove(node.node_id);
    affinity.forgetNode(node.node_id);
    batch.dirty = true;
  }

  const unregisterNode = (nodeId) => withNode(nodeId, (node, batch, now) => {
    for (const lease of activeOn(node)) stopLease(batch, lease, now);
    removeNode(batch, node);
    dispatch(batch, now);
    return { ok: true };
  });

  const touchNode = (nodeId) => withNode(nodeId, (node, batch, now) => { contact(batch, node, now); return { ok: true }; });

  // -------------------------------------------------------------------------
  // Leases.

  function readLeaseRequest(input) {
    if (!input || typeof input !== 'object') return null;
    const { conversationKey, memberId, model, wantsVision, retryAnyway = false } = input;
    const allowedNodes = normalizeAllowedNodes(input.allowedNodes, limits);
    if (!isPrintable(conversationKey, limits.maxConversationKeyLength) || !isId('member', memberId)) return null;
    if (!isPrintable(model, limits.maxModelIdLength) || typeof wantsVision !== 'boolean') return null;
    if (typeof retryAnyway !== 'boolean' || allowedNodes === undefined) return null;
    return { conversationKey, memberId, model, wantsVision, retryAnyway, allowedNodes };
  }

  function requestLease(input) {
    const request = readLeaseRequest(input);
    if (!request) return fail('invalid', 'lease_request_invalid');
    const now = clock();
    const views = nodeViews();
    const advertised = views.filter((v) => v.online).map((v) => modelEntry(v, request.model)).filter(Boolean);
    if (advertised.length === 0) return fail('limit', 'model_not_in_pool');
    if (request.wantsVision && !advertised.some((entry) => entry.vision)) return fail('limit', 'model_lacks_vision');
    const excludedNodeId = request.retryAnyway ? null : exclusions.get(request.conversationKey, now);
    if (!views.some((v) => isEligible(v, request, { excludedNodeId, ignoreSlots: true }))) {
      return fail('limit', 'no_eligible_node');
    }
    if (queuedLeases().length >= limits.maxQueued) return fail('limit', 'pool_queue_full');
    return mutate((batch) => {
      if (request.retryAnyway) exclusions.clear(request.conversationKey);
      const { record, transition } = leases.create(request, now);
      batch.transitions.push({ ...transition, id: record.lease_id, lease: record });
      batch.dirty = true;
      dispatch(batch, now);
      return { ok: true, lease: viewLease(record) };
    }, now);
  }

  function withActiveLease(leaseId, action) {
    const lease = leases.get(leaseId);
    if (!lease) return fail('forbidden', 'lease_not_found');
    if (lease.state !== 'active') return fail('conflict', 'lease_not_active');
    return action(lease);
  }

  const releaseLease = (leaseId) => withActiveLease(leaseId, (lease) => {
    const job = liveJob(lease);
    if (job && JOB_RUNNING.has(job.state)) return fail('conflict', 'lease_busy');
    return mutate((batch, now) => {
      if (job) moveJob(batch, job, 'queued', 'failed', 'lease_terminal', 'settled', now);
      moveLease(batch, lease, 'active', 'released', 'settled', 'settled', now);
      dispatch(batch, now);
      return { ok: true, lease: viewLease(lease) };
    });
  });

  function cancelLease(leaseId, { reason = 'cancelled' } = {}) {
    if (!CANCEL_REASONS.includes(reason)) return fail('invalid', 'lease_request_invalid');
    const lease = leases.get(leaseId);
    if (!lease) return fail('forbidden', 'lease_not_found');
    if (lease.state !== 'queued' && lease.state !== 'active') return fail('conflict', 'lease_not_active');
    return mutate((batch, now) => {
      if (lease.state === 'queued') moveLease(batch, lease, 'queued', 'failed', reason, reason, now);
      else {
        endActiveLease(batch, lease, { to: 'failed', trigger: reason, reason,
          runningJob: { to: 'cancelled', trigger: 'lease_cancelled' } }, now);
      }
      dispatch(batch, now);
      return { ok: true, lease: viewLease(lease) };
    });
  }

  const takeRouteToken = (leaseId) => withActiveLease(leaseId, (lease) => {
    const token = leases.takeToken(lease);
    return token === null ? fail('conflict', 'route_token_taken') : { ok: true, token };
  });

  function resolveToken(token) {
    const found = leases.resolveToken(token);
    if (!found) return null;
    return found.status === 'active' ? { status: 'active', lease: viewLease(found.record) } : { status: 'inactive' };
  }

  // -------------------------------------------------------------------------
  // Jobs.

  // Takes ownership of requestBytes (no copy): the caller must not change the buffer afterwards.
  const createJob = (leaseId, { requestBytes, stream = true } = {}) => withActiveLease(leaseId, (lease) => {
    if (liveJob(lease)) return fail('conflict', 'lease_busy');
    if (!Buffer.isBuffer(requestBytes) || typeof stream !== 'boolean') return fail('invalid', 'job_request_invalid');
    if (requestBytes.length > limits.maxRequestBytes) return fail('invalid', 'job_request_too_large');
    // R16-F02: a job for a paused node would wait for a claim that does not come: the lease ends now, so a
    // retried job finds no lease (lease_not_active) and the next turn asks for a new one.
    if (nodes.get(lease.node_id)?.paused) {
      return mutate((batch, now) => { busyLease(batch, lease, now); dispatch(batch, now); return fail('unavailable', 'node_busy'); });
    }
    return mutate((batch, now) => {
      const { record, transition } = jobs.create(lease, requestBytes, stream, now);
      batch.transitions.push({ ...transition, id: record.job_id, job: record });
      Object.assign(lease, { job_count: lease.job_count + 1, live_job_id: record.job_id, last_job_at: now });
      affinity.touch(lease.conversation_key, now);
      // A job on a lease, the first or a continuation, counts as the member being served; waiting turns may reorder.
      served.mark(lease.member_id);
      batch.dirty = leases.all().some((l) => l.state === 'queued');
      return { ok: true, job: jobView(record) };
    });
  });

  function watchJob(jobId, watcher) {
    const job = jobs.get(jobId);
    if (!job || !JOB_LIVE.has(job.state) || typeof watcher !== 'function') return null;
    if (job.watchers.length >= limits.maxWatchersPerJob) return null;
    job.watchers.push(watcher);
    return () => { job.watchers = job.watchers.filter((w) => w !== watcher); };
  }

  function claim(nodeId, claimSeq) {
    if (!Number.isSafeInteger(claimSeq) || claimSeq < 0) {
      return nodes.get(nodeId) ? fail('invalid', 'node_protocol_invalid') : fail('forbidden', 'node_not_found');
    }
    return withNode(nodeId, (node, batch, now) => {
      contact(batch, node, now);
      if (node.claims.has(claimSeq)) {
        const prior = jobs.get(node.claims.get(claimSeq));
        return { ok: true, job: prior ? claimDescriptor(prior, limits) : null };
      }
      const queued = jobs.all().filter((job) => job.state === 'queued' && job.node_id === node.node_id);
      if (queued.length === 0) return { ok: true, job: null };
      const job = orderWaiting(queued, node)[0];
      moveJob(batch, job, 'queued', 'claimed', 'claimed', null, now);
      job.claim_seq = claimSeq;
      node.claims.set(claimSeq, job.job_id);
      while (node.claims.size > limits.maxClaimsPerNode) node.claims.delete(node.claims.keys().next().value);
      return { ok: true, job: claimDescriptor(job, limits) };
    });
  }

  function jobRequest(jobId, nodeId) {
    const job = jobs.get(jobId);
    if (!job || job.node_id !== nodeId || job.state !== 'claimed' || !job.request) return fail('forbidden', 'job_not_found');
    return { ok: true, request: job.request };
  }

  function acceptChunk(jobId, nodeId, seq, bytes, final) {
    const job = jobs.get(jobId);
    const node = nodes.get(nodeId);
    if (!job || !node || job.node_id !== nodeId || !JOB_RUNNING.has(job.state)) return BARE_REFUSAL;
    if (!Number.isSafeInteger(seq) || seq !== job.next_seq) {
      return { ...fail('invalid', 'node_chunk_seq_invalid'), next_seq: job.next_seq };
    }
    if (!Buffer.isBuffer(bytes) || typeof final !== 'boolean') return fail('invalid', 'node_protocol_invalid');
    if (bytes.length > limits.maxChunkBytes) return fail('invalid', 'node_chunk_too_large');
    const scan = scanChunk(job, bytes, final, limits);
    return mutate((batch, now) => {
      contact(batch, node, now);
      if (job.state === 'claimed' && bytes.length > 0) moveJob(batch, job, 'claimed', 'streaming', 'first_chunk', null, now);
      let cancel = false;
      if (scan.violation) {
        Object.assign(job, { next_seq: job.next_seq + 1 });
        failRunning(batch, job, 'size_bound', scan.violation, now);
        cancel = true;
      } else {
        jobs.applyScan(job, scan, bytes, now);
        // Copied only for a watcher; queued before any terminal effect, so watchers see the bytes, then the end.
        if (bytes.length > 0 && job.watchers.length > 0) {
          const data = { type: 'data', bytes: Buffer.from(bytes) };
          batch.effects.push(() => notify(job, data));
        }
        const complete = !job.stream || scan.sawDone;
        if (final && complete && job.state === 'streaming') moveJob(batch, job, 'streaming', 'done', 'final_chunk', null, now);
        else if (final) failRunning(batch, job, 'stream_incomplete', 'stream_incomplete', now);
      }
      if (batch.transitions.length > 0) dispatch(batch, now);
      return { ok: true, next_seq: job.next_seq, cancel };
    });
  }

  function failJob(jobId, nodeId, reason) {
    const job = jobs.get(jobId);
    if (!job || job.node_id !== nodeId || !JOB_RUNNING.has(job.state)) return fail('forbidden', 'job_not_found');
    if (!NODE_FAIL_REASONS.has(reason)) return fail('invalid', 'node_fail_reason_invalid');
    return withNode(nodeId, (node, batch, now) => {
      contact(batch, node, now);
      failRunning(batch, job, 'node_fail', reason, now);
      dispatch(batch, now);
      return { ok: true };
    });
  }

  // The gateway request closed. After [DONE] the job is complete. Before it, a
  // claimed or streaming job is cancelled and its lease stays active: a turn
  // closes a request it means to replace (a thinking-budget checkpoint) and its
  // next request needs the lease; the turn's releaser or the `idle_timeout`
  // sweep ends it. A queued job that closes ends its lease.
  function cancelJob(jobId) {
    const job = jobs.get(jobId);
    if (!job) return fail('forbidden', 'job_not_found');
    if (!JOB_LIVE.has(job.state)) return fail('conflict', 'job_not_active');
    const lease = leases.get(job.lease_id);
    const leaseActive = Boolean(lease && lease.state === 'active');
    return mutate((batch, now) => {
      if (job.state === 'streaming' && job.saw_done) {
        moveJob(batch, job, 'streaming', 'done', 'closed_after_done', null, now);
      } else if (job.state === 'queued') {
        moveJob(batch, job, 'queued', 'failed', 'lease_terminal', 'cancelled', now);
        if (leaseActive) moveLease(batch, lease, 'active', 'failed', 'cancelled', 'cancelled', now);
      } else {
        moveJob(batch, job, job.state, 'cancelled', 'request_closed', 'cancelled', now);
      }
      dispatch(batch, now);
      return { ok: true };
    });
  }

  // -------------------------------------------------------------------------
  // Time.

  function sweepNode(batch, node, now) {
    if (!node.online) {
      if (now - node.offline_at >= limits.terminalKeepMs && busySlots(node.node_id) === 0) removeNode(batch, node);
      return;
    }
    if (now - node.last_contact_at < limits.nodeContactMs) return;
    nodes.setNodeFields(node, { online: false, offline_at: now });
    batch.dirty = true;
    for (const job of jobs.all()) {
      if (job.node_id === node.node_id && JOB_RUNNING.has(job.state)) failRunning(batch, job, 'node_lost', 'node_lost', now);
    }
  }

  function sweepJob(batch, job, now) {
    if (job.state === 'queued') {
      if (now - job.created_at >= limits.jobWaitMs) {
        moveJob(batch, job, 'queued', 'failed', 'wait_timeout', 'job_wait_timeout', now);
        const lease = leases.get(job.lease_id);
        if (lease && lease.state === 'active') moveLease(batch, lease, 'active', 'failed', 'job_failed', 'job_wait_timeout', now);
      } else if (!job.requeued && now - job.created_at >= limits.requeueMs) {
        moveJob(batch, job, 'queued', 'queued', 'requeued', null, now);
      }
      return;
    }
    if (now - job.claimed_at >= limits.jobTotalMs) failRunning(batch, job, 'job_timeout', 'job_timeout', now);
    else if (job.state === 'claimed' && now - job.claimed_at >= limits.firstByteMs) {
      failRunning(batch, job, 'first_byte_timeout', 'first_byte_timeout', now);
    } else if (job.state === 'streaming' && now - job.last_data_at >= limits.stallMs) {
      failRunning(batch, job, 'stall_timeout', 'stall_timeout', now);
    }
  }

  function sweepLease(batch, lease, now) {
    if (lease.state === 'queued') {
      if (now - lease.queued_at >= limits.queueWaitMs) moveLease(batch, lease, 'queued', 'failed', 'queue_timeout', 'queue_timeout', now);
      return;
    }
    if (lease.state !== 'active') return;
    const node = nodes.get(lease.node_id);
    const contactAt = Math.max(lease.active_at, node ? node.last_contact_at : -Infinity);
    let trigger = null;
    if (now - contactAt >= limits.nodeContactMs) trigger = 'node_contact_timeout';
    else if (!liveJob(lease) && now - Math.max(lease.active_at, lease.last_job_at ?? 0) >= limits.leaseIdleMs) trigger = 'idle_timeout';
    if (trigger) {
      // R16-F02: a lease whose job its node never claimed is no fault of that node's work: no exclusion.
      endActiveLease(batch, lease, { to: 'expired', trigger, reason: trigger,
        runningJob: { to: 'failed', trigger: 'node_lost' }, exclude: liveJob(lease)?.state !== 'queued' }, now);
    }
  }

  function sweep(now) {
    if (!Number.isFinite(now)) throw new TypeError('sweep needs the current time.');
    const batch = newBatch();
    for (const node of nodes.all()) sweepNode(batch, node, now);
    for (const job of jobs.all()) if (JOB_LIVE.has(job.state)) sweepJob(batch, job, now);
    for (const lease of leases.all()) sweepLease(batch, lease, now);
    leases.purge(now);
    jobs.purge(now);
    affinity.sweep(now);
    exclusions.sweep(now);
    dispatch(batch, now);
    return finish(batch);
  }

  // -------------------------------------------------------------------------
  // The facade.

  const getLease = (leaseId) => { const lease = leases.get(leaseId); return lease ? viewLease(lease) : null; };
  const getJob = (jobId) => { const job = jobs.get(jobId); return job ? jobView(job) : null; };

  return Object.freeze({
    limits,
    registerNode, unregisterNode, touchNode, setNodePaused,
    listNodes: nodeViews,
    nodeIdForDevice: (deviceId) => nodes.byDevice(deviceId)?.node_id || null,
    poolSummary: () => poolSummary(nodes.all()),
    requestLease, releaseLease, cancelLease, getLease,
    listLeases: () => leases.all().map(viewLease),
    takeRouteToken, resolveToken,
    clearExclusion: (conversationKey) => { exclusions.clear(conversationKey); return { ok: true }; },
    createJob, getJob, listJobs: () => jobs.all().map(jobView), watchJob,
    claim, jobRequest, acceptChunk, failJob, cancelJob,
    sweep, onChange: feed.onChange,
  });
}

module.exports = { createPoolScheduler };
