'use strict';

// Turns alternate between members, on a team host only (the scheduler's `memberTurns`
// option). This reorders the pending work one dispatch pass tries, nothing else:
// - work whose durable request carries a trusted member author (`input.request.author`)
//   is visited round-robin by member, the member served longest ago first, submission
//   order within a member;
// - work with no member author keeps its slot exactly;
// - the served record is per scheduler object, memory only, and bounded at MAX_MEMBERS
//   (the pool scheduler's own `createMemberServed`); "served" is a dispatch that started.

const { normalizeMessageAuthor } = require('../backend/message-author');
const { createMemberServed } = require('../../server/team/scheduler/state');

const MAX_MEMBERS = 64;
const records = new WeakMap(); // scheduler -> { served, authors: Map(work_id -> member_id | null) }

function recordFor(owner) {
  let record = records.get(owner);
  if (!record) {
    record = { served: createMemberServed({ max: MAX_MEMBERS }), authors: new Map() };
    records.set(owner, record);
  }
  return record;
}

// The member who wrote a pending turn, or null. A read that throws counts as no author.
function memberOf(readWork, summary) {
  try {
    return normalizeMessageAuthor(readWork(summary.work_id)?.input?.request?.author)?.member_id ?? null;
  } catch (_error) {
    return null;
  }
}

/**
 * The pass order for `candidates` (pending summaries in submission order).
 * `rank(memberId)` is 0 for a member never served, larger the more recently served.
 * Returns `candidates` itself when no item has a member author.
 */
function orderByMember(candidates, memberOfItem, rank) {
  const members = candidates.map(memberOfItem);
  if (!members.some(Boolean)) return candidates;
  const byMember = new Map(); // member_id -> its items, submission order; insertion order is first arrival
  candidates.forEach((item, index) => {
    const member = members[index];
    if (!member) return;
    if (!byMember.has(member)) byMember.set(member, []);
    byMember.get(member).push(item);
  });
  const arrival = [...byMember.keys()];
  const order = arrival.toSorted((a, b) => rank(a) - rank(b) || arrival.indexOf(a) - arrival.indexOf(b));
  const authored = [];
  const total = members.filter(Boolean).length;
  for (let round = 0; authored.length < total; round += 1) {
    for (const member of order) {
      const item = byMember.get(member)[round];
      if (item) authored.push(item);
    }
  }
  // Authorless work keeps its slots; the authored slots take the round-robin order.
  let next = 0;
  return candidates.map((item, index) => (members[index] ? authored[next++] : item));
}

/**
 * The scheduler's pass: yields the candidates in member order, and after each one the
 * scheduler tried, marks its member served when the scheduler now holds it as active.
 * `owner` is the SessionRuntimeScheduler (its `store.get` and `active` map are read).
 */
function* memberTurnOrder(owner, candidates) {
  const record = recordFor(owner);
  const readWork = (workId) => owner.store.get(workId);
  // A pending turn's author never changes (a prompt edit keeps it), so each work item is read
  // once while it stays pending; the cache holds only this pass's candidates.
  const known = record.authors;
  record.authors = new Map(candidates.map((summary) => [summary.work_id,
    known.has(summary.work_id) ? known.get(summary.work_id) : memberOf(readWork, summary)]));
  const ordered = orderByMember(candidates, (summary) => record.authors.get(summary.work_id), record.served.rank);
  for (const summary of ordered) {
    yield summary;
    const member = record.authors.get(summary.work_id);
    if (member && owner.active?.has?.(summary.work_id)) record.served.mark(member);
  }
}

module.exports = { memberTurnOrder, orderByMember };
