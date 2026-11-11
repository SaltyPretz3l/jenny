'use strict';

// One membership event per durable commit that revokes a member or device,
// changes a role, admits, or transfers ownership. Subscribers run in
// registration order. A subscriber that throws is logged without its payload
// and sets the degraded flag; the later subscribers still run. The flag is
// sticky until restart: nothing here clears it.
//
// Project changes (TEAM_PROJECTS_SPEC slice 3-1) go to their own subscriber
// list, `onProjectChange`, so the membership subscribers (device revocation,
// lease and stream fan-out, the parent notice) never see a kind they were not
// written for. They share the degraded flag. A cascade inside a team change
// emits no project event: the team change's own event already names the member.

const { safeLogger } = require('./safe-logger');

const EVENT_KINDS = Object.freeze([
  'admitted', 'role_changed', 'member_revoked', 'device_revoked', 'owner_transferred',
]);
const PROJECT_EVENT_REASONS = Object.freeze(['created', 'members', 'deleting', 'deleted']);

function createMembershipEvents({ logger = null } = {}) {
  const listeners = [];
  const projectListeners = [];
  let degraded = false;

  const log = safeLogger(logger);

  function markDegraded(eventKind, index) {
    degraded = true;
    // Ids, kinds and counts only: never the payload, never the error text.
    log('ERROR', 'team_membership.subscriber_failed', { event_kind: eventKind, subscriber: index });
  }

  function subscribe(list, listener) {
    if (typeof listener !== 'function') throw new TypeError('A membership subscriber must be a function.');
    const entry = { listener };
    list.push(entry);
    return () => {
      const index = list.indexOf(entry);
      if (index >= 0) list.splice(index, 1);
    };
  }

  function deliver(list, payload, label) {
    [...list].forEach((entry, index) => {
      try {
        const returned = entry.listener(payload);
        if (returned && typeof returned.then === 'function') {
          returned.then(undefined, () => markDegraded(label, index));
        }
      } catch (_error) {
        markDegraded(label, index);
      }
    });
    return payload;
  }

  const onMembershipChange = (listener) => subscribe(listeners, listener);
  const onProjectChange = (listener) => subscribe(projectListeners, listener);

  function emit(event) {
    if (!EVENT_KINDS.includes(event?.kind)) throw new TypeError('Unknown membership event kind.');
    const payload = Object.freeze({
      kind: event.kind,
      member_id: event.member_id,
      device_ids: Object.freeze([...event.device_ids]),
      role: event.role,
      at: event.at,
    });
    return deliver(listeners, payload, payload.kind);
  }

  // Ids only: the project and the members whose access it changed.
  function emitProject(event) {
    if (!PROJECT_EVENT_REASONS.includes(event?.reason)) throw new TypeError('Unknown project event reason.');
    const payload = Object.freeze({
      reason: event.reason,
      project_id: event.project_id,
      member_ids: Object.freeze([...event.member_ids]),
      at: event.at,
    });
    return deliver(projectListeners, payload, `project_${payload.reason}`);
  }

  return {
    onMembershipChange,
    onProjectChange,
    emit,
    emitProject,
    isDegraded: () => degraded,
  };
}

// The kinds that end a device: every holder of per-device state forgets it on these.
const REVOKE_EVENT_KINDS = Object.freeze(new Set(['member_revoked', 'device_revoked']));

module.exports = {
  EVENT_KINDS, PROJECT_EVENT_REASONS, REVOKE_EVENT_KINDS, createMembershipEvents,
};
