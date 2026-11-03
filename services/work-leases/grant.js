'use strict';
// Grant computation and nested-process coverage (protocol: "Grant computation", "Nested processes").
// Pure: callers pass the live tickets (after pruning) plus any synthetic external holders.

const {
  effectiveEnforcement, effectiveResource, effectiveState,
} = require('./record');

const bySeq = (a, b) => a.seq - b.seq;

function normalizeTicket(ticket) {
  return {
    source: ticket,
    seq: ticket.seq,
    held: effectiveState(ticket.state) === 'held',
    blocking: effectiveEnforcement(ticket.enforcement) === 'blocking',
    resources: (ticket.resources || []).map(effectiveResource),
  };
}

function declaredCapacities(blocking) {
  const capacity = new Map();
  for (const t of blocking) {
    for (const r of t.resources) {
      if (r.capacity === null) continue;
      const current = capacity.get(r.key);
      capacity.set(r.key, current === undefined ? r.capacity : Math.min(current, r.capacity));
    }
  }
  return capacity;
}

// Runs the doc's pseudocode. With targetSeq it also records which tickets stand in that waiting
// ticket's way, for UI and diagnostics; the grant decisions are identical either way.
function analyse(tickets, targetSeq) {
  const blocking = tickets.map(normalizeTicket).filter((t) => t.blocking).sort(bySeq);
  const capacityOf = declaredCapacities(blocking);
  const takeOf = (r) => {
    const capacity = capacityOf.get(r.key);
    return r.units === 'all' || (capacity !== undefined && r.units > capacity) ? 'all' : r.units;
  };
  const used = new Map();
  const exclusive = new Set();
  const takers = new Map(); // key -> normalized tickets whose takes were applied
  const reservers = new Map(); // key -> earlier waiting tickets that did not fit
  const apply = (t) => {
    for (const r of t.resources) {
      if (takeOf(r) === 'all') exclusive.add(r.key);
      else used.set(r.key, (used.get(r.key) || 0) + takeOf(r));
      if (!takers.has(r.key)) takers.set(r.key, []);
      takers.get(r.key).push(t);
    }
  };
  for (const t of blocking) if (t.held) apply(t); // already held: counted unconditionally

  const blocked = new Set();
  const grants = [];
  let inTheWay = [];
  for (const t of blocking) {
    if (t.held) continue;
    const fits = t.resources.every((r) => {
      if (blocked.has(r.key) || exclusive.has(r.key)) return false;
      const inUse = used.get(r.key) || 0;
      const take = takeOf(r);
      if (take === 'all') return inUse === 0;
      const capacity = capacityOf.get(r.key);
      return capacity === undefined || inUse + take <= capacity;
    });
    if (t.seq === targetSeq && !fits) {
      const ways = new Set();
      for (const r of t.resources) {
        for (const w of reservers.get(r.key) || []) ways.add(w);
        for (const w of takers.get(r.key) || []) ways.add(w);
      }
      inTheWay = [...ways];
    }
    if (fits) {
      grants.push(t.seq);
      apply(t);
    } else {
      for (const r of t.resources) {
        blocked.add(r.key);
        if (!reservers.has(r.key)) reservers.set(r.key, []);
        reservers.get(r.key).push(t);
      }
    }
  }
  return { grants, inTheWay: inTheWay.map((t) => t.source) };
}

// Sorted seq numbers of the waiting blocking tickets that may become held now.
function computeGrants(tickets) {
  return analyse(tickets).grants;
}

// The tickets (original objects) that keep the waiting ticket `seq` from being granted: holders
// and earlier waiters on its keys. Empty when the ticket would be granted or is not waiting.
function blockersOf(tickets, seq) {
  return analyse(tickets, seq).inTheWay;
}

// A nested process may skip a take only when an inherited ticket is live, held, blocking, lists the
// same key and takes "all" or at least as many units (a shared take never covers an exclusive one).
// Returns the takes that must still be published, in request order.
function uncoveredTakes(tickets, inheritedIds, request) {
  const inherited = new Set(inheritedIds || []);
  const parents = (tickets || [])
    .filter((t) => inherited.has(t.ticket)
      && effectiveState(t.state) === 'held' && effectiveEnforcement(t.enforcement) === 'blocking')
    .map((t) => (t.resources || []).map(effectiveResource));
  return request.filter((take) => {
    const want = effectiveResource(take).units;
    return !parents.some((resources) => resources.some((r) => r.key === take.key
      && (r.units === 'all' || (want !== 'all' && r.units >= want))));
  });
}

module.exports = { computeGrants, blockersOf, uncoveredTakes };
