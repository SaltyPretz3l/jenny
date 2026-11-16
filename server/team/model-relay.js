'use strict';

// The model relay of team model sharing (row 123, slice 6-2; TEAM_MODEL_SHARING_SPEC "The relay" and
// "6-2 as built"). Offers and transfers live in host memory only (MS5); no file system, network or timer.
// Time moves through the injected clock read at each call (the touched record is settled first) and
// `sweep()`, which 6-3 runs from its one timer. Routes wait on `wait: 'window_full' | 'not_ready'` answers
// and a one-shot `onChange`. Roles are the caller's (E55); parties are checked here, and an unknown,
// expired or other party's id answers one `team_not_found`. Answers carry no events: they go to the
// `onEvents(list)` sink after each call. Logs carry event names, ids, counts, sizes and trigger words only.

const crypto = require('node:crypto');

const { isId } = require('./ids');
const { MODEL_TRANSFER_LIMITS, validateModelManifest } = require('./model-manifest');
const {
  CANCEL_TRIGGERS, LIVE, MODEL_RELAY_ID_PATTERNS, RELAY_FAILURES, TRANSFER_TRANSITIONS, checkLimits, chooseAdmissions,
  createCallRunner, holdsSlot, isSender, manifestFailure, newId, newOffer, newTransfer, offerSummary, ownsAllocation,
  parseOutcome, partyRole, putAnswer, receivable, receiverList, relayTotals, sameStarts, transferView, validActor,
} = require('./model-relay-core');
const { parseResume } = require('./model-relay-window');
const { safeLogger } = require('./safe-logger');

const { busy, notFound, offerLimit, requestInvalid, reused, senderOffline, sharingOff, stale, taken } = RELAY_FAILURES;

/**
 * Create a relay. `clock()` answers milliseconds; `randomBytes(n)` a Buffer; `onEvents(list)` receives the
 * events for the parties; `logger(level, event, fields)` is optional. `limits` must hold every key of
 * MODEL_TRANSFER_LIMITS (tests lower sizes and times; memory-bearing keys may not rise).
 */
function createModelRelay({ clock, randomBytes = crypto.randomBytes, limits = MODEL_TRANSFER_LIMITS, logger, onEvents } = {}) {
  if (typeof clock !== 'function') throw new TypeError('createModelRelay needs a clock function.');
  if (typeof randomBytes !== 'function') throw new TypeError('createModelRelay needs randomBytes.');
  if (typeof onEvents !== 'function') throw new TypeError('createModelRelay needs an onEvents sink.');
  const L = checkLimits(limits);
  const log = safeLogger(logger);
  const offers = new Map();
  const transfers = new Map();
  // senderMemberId -> Map(request_id -> offer id), while the offer stands (MS6).
  const byRequest = new Map();
  let flowingLimit = L.flowingPerHost;
  let arrival = 0;
  let disposed = false;
  // A transfer state changed since the last admission pass.
  let changed = false;
  const runner = createCallRunner({ clock, onEvents, isDisposed: () => disposed });
  const { emit, wake } = runner;

  const call = (fn, options) => runner.run((now) => {
    const result = fn(now);
    admit(now);
    return result;
  }, options);

  function offerEvent(o, state, reason = null) {
    emit([o.senderMemberId, ...(o.direct ? [o.direct] : o.receivers)], 'team_model_offer',
      { ...offerSummary(o), state, reason });
  }

  function transferEvent(t, view = transferView(t)) {
    emit([t.senderMemberId, t.receiverMemberId], 'team_model_transfer', view);
  }

  function move(t, to, trigger, now, reason = null) {
    const allowed = TRANSFER_TRANSITIONS[`${t.state}>${to}`];
    if (!allowed || !allowed.includes(trigger)) throw new Error('model relay: transition refused');
    log('INFO', 'team_model.transfer_state', { transfer_id: t.id, from: t.state, to, trigger });
    t.state = to;
    t.reason = reason;
    if (to !== 'accepted') t.admitted = false;
    if (to === 'paused') t.window.drop();
    if (!LIVE.has(to)) {
      t.window.clear();
      t.endedAt = now;
    }
    changed = true;
    wake(t);
    transferEvent(t);
  }

  // A direct offer whose transfer ended without success, or was forgotten, is open again.
  function reopen(o, t, now) {
    if (!o || o.takenBy !== t.id) return;
    o.takenBy = null;
    o.openedAt = now;
    offerEvent(o, 'open');
  }

  function endTransfer(t, to, trigger, now, reason = trigger) {
    move(t, to, trigger, now, reason);
    const o = offers.get(t.offerId);
    if (to === 'done' && o && o.takenBy === t.id) endOffer(o, 'fulfilled', now);
    else reopen(o, t, now);
  }

  function endOffer(o, reason, now) {
    for (const id of o.transfers) {
      const t = transfers.get(id);
      if (t && LIVE.has(t.state)) move(t, 'cancelled', CANCEL_TRIGGERS.includes(reason) ? reason : 'withdrawn', now, reason);
    }
    offers.delete(o.id);
    byRequest.get(o.senderMemberId)?.delete(o.manifest.request_id);
    log('INFO', 'team_model.offer_ended', { offer_id: o.id, reason });
    offerEvent(o, 'ended', reason);
  }

  function pause(t, trigger, now) {
    t.pausedBy = trigger;
    move(t, 'paused', trigger, now, trigger);
  }

  // Grants flowing slots (only after a state change); the idle clock of a transfer starts at its admission.
  function admit(now) {
    if (!changed) return;
    changed = false;
    for (const t of chooseAdmissions(transfers.values(), flowingLimit, L)) {
      t.admitted = true;
      t.lastPartAt = now;
      wake(t);
      transferEvent(t);
    }
  }

  // False when the offer is gone.
  function settleOffer(o, now) {
    if (!offers.has(o.id)) return false;
    if (o.senderGoneAt !== null && now - o.senderGoneAt >= L.senderGraceMs) endOffer(o, 'sender_offline', now);
    else if (o.direct && !o.takenBy && now - o.openedAt >= L.directOfferLifeMs) endOffer(o, 'expired', now);
    return offers.has(o.id);
  }

  // False when the transfer is forgotten. A queued transfer is never forgotten for waiting.
  function settleTransfer(t, now) {
    const o = offers.get(t.offerId);
    if (o) settleOffer(o, now);
    if (!transfers.has(t.id)) return false;
    const queued = t.state === 'accepted' && !t.admitted;
    if (!queued && now - (LIVE.has(t.state) ? t.lastPartAt : t.endedAt) >= L.forgetIdleMs) {
      forget(t, now);
      return false;
    }
    if (holdsSlot(t) && now - t.lastPartAt >= L.pauseIdleMs) pause(t, 'idle', now);
    return true;
  }

  function forget(t, now) {
    transfers.delete(t.id);
    offers.get(t.offerId)?.transfers.delete(t.id);
    if (!LIVE.has(t.state)) return;
    log('INFO', 'team_model.transfer_forgotten', { transfer_id: t.id });
    t.window.clear();
    changed = true;
    wake(t);
    transferEvent(t, { ...transferView(t), state: 'forgotten', next: null });
    reopen(offers.get(t.offerId), t, now);
  }

  function settleAll(now) {
    for (const o of [...offers.values()]) settleOffer(o, now);
    for (const t of [...transfers.values()]) settleTransfer(t, now);
    admit(now);
  }

  function findOffer(actor, offerId, now) {
    if (!validActor(actor) || typeof offerId !== 'string' || !MODEL_RELAY_ID_PATTERNS.offer.test(offerId)) return null;
    const o = offers.get(offerId);
    return o && settleOffer(o, now) ? o : null;
  }

  // The sending member's devices and a member who may receive it see an offer; a taken direct offer only its taker.
  function visible(o, actor, canReceive) {
    if (o.senderMemberId === actor.memberId) return true;
    if (!receivable(o, actor, canReceive)) return false;
    return !o.takenBy || transfers.get(o.takenBy)?.receiverMemberId === actor.memberId;
  }

  // side: 'sender', 'receiver' or 'party'. Answers { t, role } or null.
  function findTransfer(actor, transferId, side, now) {
    if (!validActor(actor) || typeof transferId !== 'string' || !MODEL_RELAY_ID_PATTERNS.transfer.test(transferId)) return null;
    const t = transfers.get(transferId);
    if (!t || !settleTransfer(t, now)) return null;
    admit(now);
    const role = partyRole(t, actor);
    return role && (side === 'party' || side === role) ? { t, role } : null;
  }

  function liveTransfers(test) {
    return [...transfers.values()].filter((t) => LIVE.has(t.state) && test(t));
  }

  function offer(actor, body, { receivers } = {}) {
    return call((now) => {
      if (!validActor(actor)) return notFound();
      if (flowingLimit === 0) return sharingOff();
      const checked = validateModelManifest(body);
      if (!checked.ok) return manifestFailure(checked.reason, body);
      const allowed = receiverList(receivers, actor.memberId, L.maxReceivers);
      if (!allowed) return requestInvalid();
      const { manifest } = checked;
      const digest = crypto.createHash('sha256').update(JSON.stringify(manifest)).digest('hex');
      const knownId = byRequest.get(actor.memberId)?.get(manifest.request_id);
      const known = knownId ? findOffer(actor, knownId, now) : null;
      if (known) return known.digest === digest && isSender(known, actor) ? { ok: true, offer: offerSummary(known) } : reused();
      const direct = manifest.audience.kind === 'member' ? manifest.audience.member_id : null;
      if (direct === actor.memberId) return requestInvalid();
      if (direct && !allowed.includes(direct)) return notFound();
      settleAll(now);
      const all = [...offers.values()];
      if (all.length >= L.maxOffersPerHost || all.filter((o) => o.senderMemberId === actor.memberId).length >= L.maxOffersPerMember) {
        return offerLimit();
      }
      if (direct && all.filter((o) => o.direct === direct && !o.takenBy).length >= L.maxPendingDirectOffers) return offerLimit();
      const o = newOffer({ id: newId('offer_', randomBytes), actor, digest, manifest, receivers: allowed, now });
      offers.set(o.id, o);
      if (!byRequest.has(actor.memberId)) byRequest.set(actor.memberId, new Map());
      byRequest.get(actor.memberId).set(manifest.request_id, o.id);
      log('INFO', 'team_model.offer_opened', { offer_id: o.id, files: manifest.files.length, bytes: o.totalBytes });
      offerEvent(o, 'open');
      return { ok: true, offer: offerSummary(o) };
    });
  }

  function listOffers(actor, { canReceive } = {}) {
    return call((now) => {
      if (!validActor(actor)) return notFound();
      if (flowingLimit === 0) return sharingOff();
      settleAll(now);
      const shown = [...offers.values()].filter((o) => visible(o, actor, canReceive));
      const mine = [...transfers.values()].filter((t) => t.senderMemberId === actor.memberId || t.receiverMemberId === actor.memberId);
      return { ok: true, offers: shown.map(offerSummary), transfers: mine.map(transferView) };
    });
  }

  /** One offer with its whole manifest (names, hashes, provenance), for those who may see it. */
  function getOffer(actor, offerId, { canReceive } = {}) {
    return call((now) => {
      const o = findOffer(actor, offerId, now);
      if (!o || !visible(o, actor, canReceive)) return notFound();
      return { ok: true, offer: offerSummary(o), manifest: o.manifest };
    });
  }

  function withdraw(actor, offerId) {
    return call((now) => {
      const o = findOffer(actor, offerId, now);
      if (!o || !isSender(o, actor)) return notFound();
      endOffer(o, 'withdrawn', now);
      return { ok: true };
    });
  }

  function accept(actor, offerId, { resume: startPoints, canReceive } = {}) {
    return call((now) => {
      const o = findOffer(actor, offerId, now);
      if (!o || !receivable(o, actor, canReceive)) return notFound();
      if (flowingLimit === 0) return sharingOff();
      const starts = parseResume(o.manifest.files, startPoints, L.partBytes);
      if (!starts.ok) return requestInvalid();
      const [live] = liveTransfers((t) => t.offerId === o.id && t.receiverMemberId === actor.memberId);
      if (live) {
        if (live.receiverDeviceId !== actor.deviceId) return taken();
        return sameStarts(live.starts, starts.starts) ? { ok: true, transfer: transferView(live) } : reused();
      }
      if (o.senderGoneAt !== null) return senderOffline();
      if (liveTransfers((t) => t.receiverMemberId === actor.memberId).length >= L.maxLiveTransfersPerMember) return busy();
      if (!makeRoom(now)) return busy();
      arrival += 1;
      const t = newTransfer({ id: newId('mxfer_', randomBytes), o, actor, starts: starts.starts, arrival, now, limits: L });
      transfers.set(t.id, t);
      o.transfers.add(t.id);
      if (o.direct) {
        o.takenBy = t.id;
        offerEvent(o, 'taken');
      }
      log('INFO', 'team_model.transfer_accepted', { transfer_id: t.id, offer_id: o.id, bytes: t.window.bytesTotal });
      transferEvent(t);
      changed = true;
      admit(now);
      return { ok: true, transfer: transferView(t) };
    });
  }

  // Ended records make way for a new transfer, oldest first; live ones never do.
  function makeRoom(now) {
    settleAll(now);
    const ended = [...transfers.values()].filter((t) => !LIVE.has(t.state)).sort((a, b) => a.endedAt - b.endedAt);
    while (transfers.size >= L.maxTransferRecords && ended.length > 0) forget(ended.shift(), now);
    return transfers.size < L.maxTransferRecords;
  }

  function decline(actor, offerId, { canReceive } = {}) {
    return call((now) => {
      const o = findOffer(actor, offerId, now);
      if (!o || !receivable(o, actor, canReceive)) return notFound();
      if (liveTransfers((t) => t.offerId === o.id && t.receiverMemberId === actor.memberId).length > 0) return stale();
      if (o.direct) endOffer(o, 'declined', now);
      else o.declined.add(actor.memberId);
      return { ok: true };
    });
  }

  function pauseTransfer(actor, transferId) {
    return call((now) => {
      const found = findTransfer(actor, transferId, 'party', now);
      if (!found) return notFound();
      const { t, role } = found;
      if (!LIVE.has(t.state)) return stale();
      if (t.state !== 'paused') pause(t, `paused_by_${role}`, now);
      return { ok: true, transfer: transferView(t) };
    });
  }

  function resumeTransfer(actor, transferId) {
    return call((now) => {
      const found = findTransfer(actor, transferId, 'party', now);
      if (!found) return notFound();
      const { t, role } = found;
      if (!LIVE.has(t.state)) return stale();
      if (t.state === 'paused') {
        if (t.pausedBy === 'sender_offline' || offers.get(t.offerId)?.senderGoneAt !== null) return senderOffline();
        if (t.pausedBy !== 'idle' && t.pausedBy !== `paused_by_${role}`) return stale();
        t.pausedBy = null;
        move(t, 'accepted', 'resumed', now);
        admit(now);
      }
      return { ok: true, transfer: transferView(t) };
    });
  }

  function cancel(actor, transferId) {
    return call((now) => {
      const found = findTransfer(actor, transferId, 'party', now);
      if (!found) return notFound();
      const { t, role } = found;
      if (LIVE.has(t.state)) endTransfer(t, 'cancelled', `cancelled_by_${role}`, now);
      else if (t.state !== 'cancelled') return stale();
      return { ok: true, transfer: transferView(t) };
    });
  }

  function complete(actor, transferId, outcome) {
    return call((now) => {
      const found = findTransfer(actor, transferId, 'party', now);
      if (!found) return notFound();
      const { t, role } = found;
      if (role !== 'receiver') return stale();
      const ok = parseOutcome(outcome);
      if (ok === null) return requestInvalid();
      if (LIVE.has(t.state)) {
        if (ok) endTransfer(t, 'done', 'complete_ok', now, null);
        else endTransfer(t, 'failed', 'complete_failed', now, outcome.reason);
      } else if (!(ok ? t.state === 'done' : t.state === 'failed' && t.reason === outcome.reason)) return stale();
      return { ok: true, transfer: transferView(t) };
    });
  }

  function sendable(t) {
    if (t.state === 'accepted' && !t.admitted) return busy();
    return holdsSlot(t) ? null : stale();
  }

  /** Before the route reads a part's body: `{ ready: true, bytes }` names the exact body length. */
  function checkPut(actor, transferId, index, part) {
    return call((now) => {
      const found = findTransfer(actor, transferId, 'sender', now);
      if (!found) return notFound();
      const refusal = sendable(found.t);
      if (refusal) return refusal;
      const checked = found.t.window.check(index, part);
      return putAnswer(checked.word, { bytes: checked.bytes });
    });
  }

  /** Ownership of `bytes` passes to the relay: an exact-size buffer owning its whole allocation, never reused. */
  function putPart(actor, transferId, index, part, bytes) {
    return call((now) => {
      const found = findTransfer(actor, transferId, 'sender', now);
      if (!found) return notFound();
      const { t } = found;
      const refusal = sendable(t);
      if (refusal) return refusal;
      if (!ownsAllocation(bytes)) return requestInvalid();
      const word = t.window.put(index, part, bytes);
      if (word === 'ok') {
        t.lastPartAt = now;
        if (t.state === 'accepted') move(t, 'flowing', 'first_part', now);
        wake(t);
      }
      return putAnswer(word);
    });
  }

  // A streamed part's place is freed when its response ends (R14-F03): the window's release, then a state change so
  // a waiting PUT and the admission look again.
  const releaseOf = (t, release) => () => {
    if (!release() || disposed) return;
    call(() => {
      changed = true;
      wake(t);
      return { ok: true };
    }, { force: true });
  };

  /** `hold` (the part route): the answer carries `release()`, called once when the response streaming it ends. */
  function takePart(actor, transferId, index, part, { hold = false } = {}) {
    return call((now) => {
      const found = findTransfer(actor, transferId, 'receiver', now);
      if (!found) return notFound();
      const { t } = found;
      if (!LIVE.has(t.state) || t.state === 'paused') return stale();
      const result = t.window.take(index, part, { hold });
      if (result.released > 0) wake(t);
      if (result.word === 'stale') return stale();
      if (result.word === 'not_ready') return { ok: true, ready: false, wait: 'not_ready' };
      if (result.first) t.lastPartAt = now;
      return { ok: true, ready: true, bytes: result.bytes, ...(result.release ? { release: releaseOf(t, result.release) } : {}) };
    });
  }

  /** A one-shot wake-up on the transfer's next change; `off()` removes it. At most 2 per party (1 for the sender). */
  function onChange(actor, transferId, listener) {
    return call((now) => {
      const found = findTransfer(actor, transferId, 'party', now);
      if (!found) return notFound();
      const { t, role } = found;
      if (typeof listener !== 'function') return requestInvalid();
      if (!LIVE.has(t.state)) return stale();
      const cap = role === 'sender' ? L.waitingPutsPerTransfer : L.partRequestsPerParty;
      if ([...t.listeners].filter((entry) => entry.role === role).length >= cap) return busy();
      const entry = { role, fn: listener };
      t.listeners.add(entry);
      return { ok: true, off: () => t.listeners.delete(entry) };
    });
  }

  /** Read-only, for the part routes' once-a-second check: `{ ok: true }` while the transfer is live for this party. */
  function partyLive(actor, transferId) {
    return call((now) => {
      const found = findTransfer(actor, transferId, 'party', now);
      if (!found) return notFound();
      return LIVE.has(found.t.state) ? { ok: true } : stale();
    });
  }

  // Everything of one member (or of everyone, memberId null) ends as cancelled.
  function endWhere(memberId, reason, now) {
    for (const o of [...offers.values()]) {
      if (memberId === null || o.senderMemberId === memberId || o.direct === memberId) endOffer(o, reason, now);
      else {
        o.receivers = o.receivers.filter((id) => id !== memberId);
        o.declined.delete(memberId);
      }
    }
    for (const t of liveTransfers((x) => memberId === null || x.senderMemberId === memberId || x.receiverMemberId === memberId)) {
      endTransfer(t, 'cancelled', reason, now);
    }
    if (memberId === null) byRequest.clear();
    else byRequest.delete(memberId);
  }

  function endMember(memberId, reason) {
    return call((now) => {
      if (!isId('member', memberId)) return requestInvalid();
      endWhere(memberId, reason, now);
      return { ok: true };
    });
  }

  // The offering device dropped (gone) or came back inside its grace.
  function deviceSeen(deviceId, gone) {
    return call((now) => {
      if (!isId('device', deviceId)) return requestInvalid();
      for (const o of [...offers.values()]) {
        if (o.senderDeviceId !== deviceId || !settleOffer(o, now) || (o.senderGoneAt !== null) === gone) continue;
        o.senderGoneAt = gone ? now : null;
        for (const t of liveTransfers((x) => x.offerId === o.id)) {
          if (gone && t.state !== 'paused') pause(t, 'sender_offline', now);
          if (!gone && t.state === 'paused' && t.pausedBy === 'sender_offline') {
            t.pausedBy = null;
            move(t, 'accepted', 'sender_back', now);
          }
        }
      }
      return { ok: true };
    });
  }

  /** 0 to maxFlowingPerHost. 0 turns the relay off: every offer and live transfer ends as `sharing_off`. */
  function setFlowingLimit(n) {
    if (!Number.isSafeInteger(n) || n < 0 || n > L.maxFlowingPerHost) return requestInvalid();
    return call((now) => {
      flowingLimit = n;
      log('INFO', 'team_model.flowing_limit', { flowing: n });
      if (n === 0) endWhere(null, 'sharing_off', now);
      changed = true;
      return { ok: true };
    }, { force: n === 0 });
  }

  function resources() {
    let requestIds = 0;
    for (const held of byRequest.values()) requestIds += held.size;
    return {
      offers: offers.size, ...relayTotals(transfers.values()), pendingEvents: runner.pendingEvents(), requestIds,
      flowingLimit, disposed,
    };
  }

  /** Force local (E64) and host stop: everything ends, listeners fire once and are gone, no part bytes stay. */
  function dispose() {
    const result = call((now) => {
      endWhere(null, 'host_stopping', now);
      log('INFO', 'team_model.disposed', { transfers: transfers.size });
      return { ok: true };
    }, { force: true });
    if (!result.ok) return result;
    transfers.clear();
    offers.clear();
    disposed = true;
    return result;
  }

  return {
    offer, listOffers, getOffer, withdraw, accept, decline, pause: pauseTransfer, resume: resumeTransfer, cancel,
    complete, checkPut, putPart, takePart, onChange, partyLive, setFlowingLimit, resources, dispose,
    memberGone: (memberId) => endMember(memberId, 'member_gone'),
    roleChanged: (memberId, canShare) => (canShare === true ? call(() => ({ ok: true })) : endMember(memberId, 'role_changed')),
    deviceGone: (deviceId) => deviceSeen(deviceId, true),
    deviceBack: (deviceId) => deviceSeen(deviceId, false),
    sweep: () => call((now) => {
      settleAll(now);
      return { ok: true };
    }),
  };
}

module.exports = { createModelRelay };
