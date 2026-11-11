'use strict';

// The wait order (row 123, slice 4a-1; spec "Choosing a node" step 3). One
// replaceable ordering function: continuation jobs first, then the node owner's
// own turns on their node, then arrival order. Slice 4d replaces the last tier
// with per-member round-robin (least recently served member first) and keeps the
// signature: orderWaiting(items, node) returns a new sorted array.
//
// An item is { continuation: boolean, member_id: string, seq: number }, where seq
// is a monotonic arrival number. `node` is the node a slot is free on, or null for
// the pool-wide order used to report queue positions.

function tier(item, node) {
  if (item.continuation) return 0;
  if (node && item.member_id === node.member_id) return 1;
  return 2;
}

function compareWaiting(a, b, node) {
  return tier(a, node) - tier(b, node) || a.seq - b.seq;
}

function orderWaiting(items, node = null) {
  return [...items].sort((a, b) => compareWaiting(a, b, node));
}

module.exports = { orderWaiting };
