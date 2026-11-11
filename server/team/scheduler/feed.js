'use strict';

// The change feed of the team pool scheduler (row 123, slice 4a-1). One place
// for the listener set, the change events built from transitions, the queue and
// slot signatures, and ordered delivery: a listener that calls back into the
// scheduler appends that call's events behind the ones still being delivered,
// so every listener sees events in causal order and the last `queue` and
// `nodes` events match the final state.

function transitionEvent(t) {
  return t.table === 'lease'
    ? { type: 'lease', lease_id: t.id, conversation_key: t.lease.conversation_key, member_id: t.lease.member_id,
      node_id: t.lease.node_id, from: t.from, to: t.to, trigger: t.trigger, reason: t.reason }
    : { type: 'job', job_id: t.id, lease_id: t.job.lease_id, node_id: t.job.node_id, from: t.from, to: t.to,
      trigger: t.trigger, reason: t.reason };
}

function createFeed({ maxListeners, log }) {
  const listeners = new Set(); // at most maxListeners
  const pending = []; // events waiting for delivery, in causal order
  let delivering = false;
  let queueSignature = '[]';
  let nodesSignature = '';

  function onChange(listener) {
    if (typeof listener !== 'function') throw new TypeError('onChange needs a function.');
    if (listeners.size >= maxListeners) throw new RangeError('Too many pool listeners.');
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  }

  function drain() {
    if (delivering) return;
    delivering = true;
    try {
      while (pending.length > 0) {
        const event = pending.shift();
        for (const listener of [...listeners]) {
          try { listener(event); } catch (_error) { log('warn', 'team.pool.listener_failed', { type: event.type }); }
        }
      }
    } finally {
      delivering = false;
    }
  }

  /**
   * Publishes one call's transitions, then, when `signals` is given, a `queue`
   * event if the positions changed and a `nodes` event if the slots or node count did.
   * signals: { positions: [{ lease_id, conversation_key, member_id, position }], onlineSlots, nodeCount }.
   */
  function publish(transitions, signals) {
    for (const t of transitions) {
      log('info', 'team.pool.transition', { table: t.table, id: t.id, from: t.from, to: t.to, trigger: t.trigger,
        reason: t.reason });
      pending.push(transitionEvent(t));
    }
    if (signals) {
      const nextQueue = JSON.stringify(signals.positions);
      if (nextQueue !== queueSignature) {
        queueSignature = nextQueue;
        pending.push({ type: 'queue', positions: signals.positions });
      }
      const nextNodes = `${signals.onlineSlots}|${signals.nodeCount}`;
      if (nextNodes !== nodesSignature) {
        nodesSignature = nextNodes;
        pending.push({ type: 'nodes', online_slots: signals.onlineSlots, nodes: signals.nodeCount });
      }
    }
    drain();
  }

  return { onChange, publish };
}

module.exports = { createFeed };
