'use strict';

const { createHash } = require('node:crypto');
const { stableJson, validId } = require('./contracts');
const { exact, fail, spawnIdentity } = require('./lineage-contracts');
const { assertRuntimeWork, resolveChildLineage } = require('./runtime-work-authority');
const { proveDependencyPrefix, spawnReceipt } = require('./dependency-proof');
const { readDependencyPredecessor, assertDependencyProgress } = require('./dependency-predecessor');
const { completedEffectRefs } = require('./continuation-effect-refs');
const { proveMixedDependencyPrefix, assertPredecessorWaitOrder } = require('./dependency-mixed-proof');
const { assertDecisionProgress } = require('../backend/runtime-decision-proof');
const { publishRuntimeChild } = require('../backend/runtime-child-publication');

function receipt(root, work) {
  return Object.freeze(spawnReceipt(root.root_run_id, work));
}

// Application-owned publication; model arguments cannot choose authority or IDs.
class RuntimeChildOperations {
  constructor(runtime, service) {
    this.runtime = runtime;
    this.service = service;
    this.publications = new Map();
  }
  bind({ work, context, assertCurrent }) {
    if (!['root_chat', 'child_chat'].includes(work.input.kind)
      || (work.input.kind === 'root_chat' && work.input.root_run?.schema_version !== 2)) return null;
    let closed = false;
    const check = () => {
      assertCurrent();
      const current = this.runtime.store.get(work.work_id);
      if (closed || !this.runtime.scheduler.enabled || this.runtime.scheduler.closing
        || current.status !== 'running' || current.control_request
        || current.turn_id !== work.turn_id || stableJson(current.attempt) !== stableJson(work.attempt)) {
        fail('runtime_child_parent_not_current');
      }
      const root = assertRuntimeWork(this.runtime.budgetStore, this.service, current, context);
      if (root?.schema_version !== 2) fail('runtime_child_root_grant_required');
      return { work: current, root, rootWork: current.input.kind === 'root_chat'
        ? current : resolveChildLineage(this.runtime, current).rootWork };
    };
    const validateWait = (operationId, toolId, args, refs, events, repeated = null) => {
      if (!validId(operationId) || toolId !== 'session_wait' || !exact(args, ['child_work_id'])
        || !validId(args.child_work_id) || !Array.isArray(refs)) fail('runtime_dependency_wait_invalid');
      const { work: current } = check();
      let previous = null;
      if (current.checkpoint_ref) {
        if (!repeated || stableJson(current.checkpoint_ref) !== stableJson(repeated.prior_checkpoint_ref)) {
          fail('runtime_dependency_prior_checkpoint_unsupported');
        }
        previous = readDependencyPredecessor(this.runtime, current, current.checkpoint_ref);
        if (repeated.completed_effect_refs) {
          assertDecisionProgress({ ...previous.checkpoint, completed_effect_refs: previous.checkpoint.completed_effect_refs || completedEffectRefs(previous.payload.turnEvents) },
            repeated, previous.payload.toolBatch.calls, repeated.tool_calls, previous.payload, { frozenFirstInput: repeated.frozen_input });
          assertPredecessorWaitOrder(previous.checkpoint, { ...repeated, source_attempt: current.attempt }, events);
        } else assertDependencyProgress(previous.checkpoint, { ...repeated, completed_spawn_refs: refs,
          source_attempt: current.attempt }, events);
      } else if (repeated && (!repeated.completed_effect_refs || repeated.prior_checkpoint_ref !== null || repeated.prior_effect_count !== 0)) fail('runtime_dependency_predecessor_invalid');
      const priorEvents = previous?.payload.turnEvents || [];
      const proof = repeated?.completed_effect_refs ? proveMixedDependencyPrefix : proveDependencyPrefix;
      return proof({ runtime: this.runtime, work: current,
        events: [...priorEvents, ...events], dependencyId: args.child_work_id, expectedRefs: refs, pendingCallId: operationId,
        expectedWaitRefs: repeated?.completed_wait_refs ?? null, expectedEffects: repeated?.completed_effect_refs, expectedEmittedCount: repeated?.eligibility?.emitted_tool_execution_count,
        permittedStreams: [...new Set(priorEvents.map(event => event.event_id.split(':')[0])), current.attempt.stream_id] });
    };
    return Object.freeze({ assertCurrent: check, validateWait, spawn: (args, callId) => this._spawn(args, callId, context, check),
      close: () => { closed = true; } });
  }
  async _spawn(args, callId, context, check) {
    if (!exact(args, ['task']) || typeof args.task !== 'string' || !args.task.trim()
      || Buffer.byteLength(args.task, 'utf8') > 65536 || !validId(callId)) fail('runtime_child_arguments_invalid');
    const task = args.task;
    const { work, root, rootWork } = check();
    const argsSha256 = createHash('sha256').update(stableJson(args)).digest('hex');
    const identity = spawnIdentity({ rootRunId: root.root_run_id,
      parentWorkId: work.work_id, parentTurnId: work.turn_id, callId });
    const active = this.publications.get(identity.work_id);
    if (active) {
      if (active.argsSha256 !== argsSha256) fail('lineage_spawn_conflict');
      return active.promise;
    }
    if (this.publications.size >= 256) fail('runtime_child_publication_capacity');
    const { record: lineage } = this.runtime.lineageStore.create({ rootRunId: root.root_run_id,
      rootWorkId: rootWork.work_id, rootSessionId: rootWork.session_id, rootTurnId: rootWork.turn_id,
      projectId: rootWork.project_id, providerId: rootWork.input.route.provider_id,
      authorityFingerprint: root.authority_fingerprint, limits: root.orchestration_limits });
    const existing = lineage.children.find(row => row.work_id === identity.work_id);
    if (!existing) {
      const lane = this.runtime.lanes.snapshot().configured[context.route.resource_class];
      const parentDepth = work.work_id === rootWork.work_id ? 0
        : lineage.children.find(row => row.work_id === work.work_id)?.depth;
      if (lineage.children.length >= lane.descendants || parentDepth >= lane.descendant_depth) {
        fail('lineage_descendant_capacity');
      }
    }
    const { child } = this.runtime.lineageStore.beginSpawn({ rootRunId: root.root_run_id,
      parentWorkId: work.work_id, parentTurnId: work.turn_id, callId, argsSha256 });
    if (child.state === 'committed') {
      const published = this.runtime.store.get(child.work_id);
      resolveChildLineage(this.runtime, published);
      return receipt(root, published);
    }
    // Defer the first await until after registering the in-flight identity.
    const promise = Promise.resolve().then(() => {
      check();
      return publishRuntimeChild(this, { work, context, rootWork, root, child,
        task, assertCurrent: check });
    }).then(published => receipt(root, published)).finally(() => this.publications.delete(identity.work_id));
    this.publications.set(identity.work_id, { argsSha256, promise });
    return promise;
  }
}

module.exports = { RuntimeChildOperations };
