'use strict';

// One team's model sharing on a member's PC (row 123 slice 6-5), built by team-models.js on the first model call for
// that team. It joins the team's connection manager (commands, the two raw part calls, the host's events) to the
// sender (model-send.js) and the receiving side (model-incoming.js over model-transport.js), keeps what the host said
// (the offers and transfers this member may see, the roster names, sharing on/off/unknown), and pushes on change.
//
// Sharing on/off (decision 7): the only signal is `team.model.offers`, read once per online connect (and by a state
// call while still unknown); `team_model_sharing_off` is off, an older host's `unsupported_operation` is off with
// `team_model_host_too_old`. Every reconnect re-reads the list and the roster, re-sends each open offer the list does
// not show with the same request id, and resumes a receive the link cut; one connect run at a time (a change during
// one runs once more after it), so a flapping link stays inside the host's 30 commands a minute. The display name an
// offer carries for its sender is the roster's, never the renderer's. Pushes (decision 10) on `team.onModel`: `state`
// (the whole state: the first change at once, then at most one per 250 ms with the last change always sent),
// `progress` (one transfer's bytes and rate, at most 4 a second per transfer) and `received`; none carries a path, a
// hash or licence text. Every failure answer is rebuilt (model-answers.js) before it leaves; the roster's role and
// state are closed words. The calls the renderer may repeat (the roster, the list while sharing is unknown, an offer's
// accept screen) run one at a time and reuse an answer younger than 2 s. What the host's events add is bounded
// (offers, transfer views) and pruned with them. Logs carry event names, ids, counts, sizes and reason words only.

const path = require('node:path');

const { MODEL_TRANSFER_LIMITS } = require('../../server/team/model-manifest');
const { isId } = require('../../server/team/ids');
const { MEMBER_STATES, ROLES, isCleanText } = require('../../server/team/member-schema');
const { commandCall, createReconnectWaiters, partCall } = require('./transfer-common');
const { modelFailure, offerSummary, offersList, transferView } = require('./model-answers');
const { MAX_RATE_MB } = require('./model-ipc');
const { createModelIncoming } = require('./model-incoming');
const { createOffersFile, createRateFile } = require('./model-offers-file');
const { modelRefusal, rowReason } = require('./model-reasons');
const { createModelSender } = require('./model-send');
const { createRateLimiter } = require('./model-send-push');
const { createModelTransport } = require('./model-transport');

const L = MODEL_TRANSFER_LIMITS;
const PROGRESS_MS = 250;
const STATE_MS = 250;
const REUSE_MS = 2000;
const RATE_WINDOW_MS = 1000;
const RECEIVING_ROLES = new Set(['owner', 'member']);
const LOCAL_METHODS = new Set(['modelState', 'modelSendable', 'modelFiles', 'modelSetRate', 'modelProvenance',
  'modelReceivePause', 'modelReceiveCancel']);
const SENDS = new Set(['modelOffer', 'modelAccept', 'modelReceiveRetry', 'modelReceiveResume']);
const aborted = () => Object.assign(new Error('aborted'), { code: 'aborted' });

function createModelTeam({
  teamId, manager, userDataPath, discovery, roots, hasher, isHeld = () => false, push = () => {}, log = () => {},
  clock = Date.now, timers = { setTimeout, clearTimeout, setInterval, clearInterval }, options = {},
}) {
  const partBytes = options.partBytes ?? L.partBytes;
  let listening = false;
  const say = (level, event, fields = {}) => { try { log(level, event, { team_id: teamId, ...fields }); } catch { /* best effort */ } };
  let stopped = false;
  let online = false;
  let sharing = 'unknown';
  let sharingReason = null;
  const offers = new Map(); // offer id -> summary
  const firstSeen = new Map(); // offer id -> ISO time this PC first saw it
  const views = new Map(); // transfer id -> view
  const pauses = new Map(); // transfer id -> paused events seen
  const sentDone = new Map(); // transfer id -> bytes this PC put since the last view
  const meters = new Map(); // transfer id -> { lastAt, windowAt, windowBytes, rate }
  const changeWaiters = new Set();
  const pending = new Set(); // timers this module set
  const roster = new Map(); // member id -> { display_name, role, state }
  const reconnects = createReconnectWaiters();

  // Timers and sleeps on the injected clock, each counted until it fires or is cleared.
  function later(ms, fn) {
    const handle = timers.setTimeout(() => { pending.delete(handle); fn(); }, Math.max(0, ms));
    handle?.unref?.();
    pending.add(handle);
    return handle;
  }
  const cancelLater = (handle) => { if (pending.delete(handle)) timers.clearTimeout(handle); };
  function sleep(ms, signal) {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) { reject(aborted()); return; }
      const onAbort = () => { cancelLater(handle); reject(aborted()); };
      const handle = later(ms, () => { signal?.removeEventListener('abort', onAbort); resolve(); });
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }
  // The next view of `transferId` (null: of any), or the time; an abort rejects.
  function waitChange(transferId, signal, ms) {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) { reject(aborted()); return; }
      const waiter = { transferId, done: () => { finish(); resolve(); } };
      const onAbort = () => { finish(); reject(aborted()); };
      const handle = later(ms, () => waiter.done());
      function finish() { changeWaiters.delete(waiter); cancelLater(handle); signal?.removeEventListener('abort', onAbort); }
      changeWaiters.add(waiter);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }
  const wake = (transferId) => { for (const waiter of [...changeWaiters]) if (waiter.transferId === null || waiter.transferId === transferId) waiter.done(); };

  const isOnline = () => online && !isHeld() && !stopped;
  const row = () => { try { return manager.snapshot(); } catch { return null; } };
  const command = (operation, params) => commandCall(manager, operation, params);
  const put = (transferId, index, n, bytes, signal) => partCall(manager,
    (session, client) => session.putModelPart(client, { transferId, index, n, bytes, signal }), signal);
  const getPart = (transferId, index, n, signal) => partCall(manager,
    (session, client) => session.getModelPart(client, { transferId, index, n, signal }), signal);
  const waitReconnect = (signal) => (isOnline() ? Promise.resolve() : reconnects.wait(signal));

  function self() {
    const facts = row();
    const memberId = facts?.member_id;
    if (!isId('member', memberId)) return null;
    const displayName = roster.get(memberId)?.display_name || facts.display_name;
    return isCleanText(displayName, L.maxDisplayNameChars) ? { memberId, displayName } : null;
  }
  const nameOf = (memberId) => roster.get(memberId)?.display_name ?? null;

  // The whole state: the first change on the next turn of the event loop, then at most one push per 250 ms, the last
  // change always sent when the 250 ms are up.
  let statePending = false;
  let stateTimer = null;
  let stateDirty = false;
  function pushState() {
    if (stopped) return;
    try { push({ kind: 'state', team_id: teamId, ...stateOf() }); } catch { say('WARN', 'team.model.push_failed'); }
    stateTimer = later(STATE_MS, () => {
      stateTimer = null;
      if (stateDirty) { stateDirty = false; pushState(); }
    });
  }
  function changed() {
    if (stopped) return;
    if (stateTimer || statePending) { stateDirty = stateTimer !== null; return; }
    statePending = true;
    queueMicrotask(() => { statePending = false; pushState(); });
  }

  // One run at a time per key, and an answer younger than 2 s reused (calls the renderer may repeat).
  const shared = new Map(); // key -> { task, at, value }
  function once(key, work) {
    const entry = shared.get(key);
    if (entry?.task) return entry.task;
    if (entry && clock() - entry.at < REUSE_MS) return Promise.resolve(entry.value);
    const task = Promise.resolve().then(work).then((value) => {
      if (shared.get(key)?.task === task) shared.set(key, { task: null, at: clock(), value });
      return value;
    }, (error) => { if (shared.get(key)?.task === task) shared.delete(key); throw error; });
    shared.set(key, { task, at: 0, value: null });
    while (shared.size > L.maxOffersPerHost + 2) shared.delete(shared.keys().next().value);
    return task;
  }

  function meter(transferId, done) {
    const now = clock();
    let entry = meters.get(transferId);
    if (!entry) { entry = { lastAt: -Infinity, windowAt: now, windowBytes: done, rate: 0 }; meters.set(transferId, entry); }
    if (now - entry.windowAt >= RATE_WINDOW_MS) {
      entry.rate = Math.max(0, Math.round(((done - entry.windowBytes) * 1000) / (now - entry.windowAt)));
      entry.windowAt = now;
      entry.windowBytes = done;
    }
    return entry;
  }
  // One transfer's progress: at most one push per 250 ms, the last byte always.
  function progress(direction, transferId, offerId, done, total) {
    if (stopped || !transferId) return;
    const entry = meter(transferId, done);
    const now = clock();
    // The last byte always goes out, once; nothing after it.
    if (entry.lastDone === total) return;
    if (done < total && now - entry.lastAt < PROGRESS_MS) return;
    entry.lastAt = now;
    entry.lastDone = done;
    try {
      push({ kind: 'progress', team_id: teamId, direction, transfer_id: transferId, offer_id: offerId, bytes_done: done,
        bytes_total: total, rate_bps: entry.rate });
    } catch { say('WARN', 'team.model.push_failed'); }
  }

  // A transfer's view gone: what was kept for it goes with it.
  function dropView(transferId) {
    views.delete(transferId);
    pauses.delete(transferId);
    sentDone.delete(transferId);
    meters.delete(transferId);
  }
  function dropOffer(offerId) {
    offers.delete(offerId);
    firstSeen.delete(offerId);
    shared.delete(`read:${offerId}`);
  }

  function noteView(view) {
    const before = views.get(view.transfer_id);
    if (!before && views.size >= L.maxTransferRecords) return; // past the host's own bound: not kept
    if (view.state === 'paused' && before?.state !== 'paused') pauses.set(view.transfer_id, (pauses.get(view.transfer_id) || 0) + 1);
    if (view.state === 'forgotten') dropView(view.transfer_id); else views.set(view.transfer_id, view);
    // This receiver's transfer flows again on the host (the sender came back): a take the link cut runs on.
    if (before?.state === 'paused' && (view.state === 'accepted' || view.state === 'flowing')
      && view.receiver_member_id === self()?.memberId && isOnline()) incoming.reconnected();
    if (view.state !== 'forgotten') {
      // This PC's send count never goes back; the host's taken count can pass it (the receiver's own word).
      const done = Math.min(view.bytes_total, Math.max(sentDone.get(view.transfer_id) || 0, view.bytes_done));
      sentDone.set(view.transfer_id, done);
      if (view.sender_member_id === self()?.memberId) progress('send', view.transfer_id, view.offer_id, done, view.bytes_total);
    }
    wake(view.transfer_id);
    sender.transferSeen(view);
  }

  function noteOffer(summary) {
    if (!offers.has(summary.offer_id) && offers.size >= L.maxOffersPerHost) return; // past the host's own bound
    offers.set(summary.offer_id, summary);
    if (!firstSeen.has(summary.offer_id)) firstSeen.set(summary.offer_id, new Date(clock()).toISOString());
    sender.offerSeen(summary);
    if (summary.state === 'ended') incoming.offerEnded(summary.offer_id, summary.reason);
  }

  async function readRoster() {
    let answer;
    try { answer = await command('team.members.list', {}); } catch { return false; }
    if (answer?.ok !== true || !Array.isArray(answer.members)) return false;
    roster.clear();
    for (const member of answer.members.slice(0, 64)) {
      if (isId('member', member?.member_id) && isCleanText(member.display_name, L.maxDisplayNameChars)
        && ROLES.includes(member.role) && MEMBER_STATES.includes(member.state)) {
        roster.set(member.member_id, { display_name: member.display_name, role: member.role, state: member.state });
      }
    }
    return true;
  }

  /** `team.model.offers` once: the sharing state, every offer and transfer this member may see. */
  async function readList() {
    if (!isOnline()) return null;
    let answer;
    try { answer = await command('team.model.offers', {}); } catch { return null; }
    if (stopped) return null;
    if (answer?.ok !== true) {
      const reason = answer?.error?.reason;
      if (reason === 'team_model_sharing_off' || reason === 'unsupported_operation') {
        sharing = 'off';
        sharingReason = reason === 'unsupported_operation' ? 'team_model_host_too_old' : 'team_model_sharing_off';
        changed();
      }
      return null;
    }
    const list = offersList(answer);
    if (!list) return null;
    sharing = 'on';
    sharingReason = null;
    const seenOffers = new Set(list.offers.map((summary) => summary.offer_id));
    for (const id of [...offers.keys()]) {
      if (seenOffers.has(id)) continue;
      incoming.offerEnded(id);
      // A take kept as withdrawn keeps its offer listed (as ended) until Dismiss removes the take.
      if (incoming.takeOf(id)) offers.set(id, { ...offers.get(id), state: 'ended' }); else dropOffer(id);
    }
    const seenViews = new Set(list.transfers.map((view) => view.transfer_id));
    for (const id of [...views.keys()]) if (!seenViews.has(id)) dropView(id);
    sender.listed(list.offers);
    for (const summary of list.offers) noteOffer(summary);
    for (const view of list.transfers) noteView(view);
    changed();
    return list;
  }

  function onEvent(event) {
    if (stopped || isHeld()) return;
    if (event?.event_type === 'team_model_offer') {
      const summary = offerSummary(event);
      if (summary) { noteOffer(summary); changed(); }
    } else if (event?.event_type === 'team_model_transfer') {
      const view = transferView(event);
      if (view) { noteView(view); changed(); }
    } else if (event?.event_type === 'resync_required') {
      void readList();
    }
  }

  const offersFile = createOffersFile({ userDataPath, teamId, log: say });
  const rateFile = createRateFile({ userDataPath, teamId, maxMb: MAX_RATE_MB, log: say });
  let rateMb = rateFile.load();
  const limiter = createRateLimiter({ rate: () => rateMb * 1_000_000, clock, sleep });
  const sender = createModelSender({
    teamId, discovery, hasher, self, offersFile, limiter, sleep, partBytes, log: say, onChange: changed,
    link: { command, put, online: isOnline, waitReconnect },
    transfers: { view: (id) => views.get(id) || null, pauses: (id) => pauses.get(id) || 0, refresh: () => readList(),
      waitView: (id, signal, ms) => waitChange(id, signal, ms),
      replay: (offerId) => { for (const view of [...views.values()]) if (view.offer_id === offerId) sender.transferSeen(view); } },
    onProgress: (transferId, _at, bytes) => {
      const view = views.get(transferId);
      if (!view) return;
      const done = Math.min(view.bytes_total, (sentDone.get(transferId) || 0) + bytes);
      sentDone.set(transferId, done);
      progress('send', transferId, view.offer_id, done, view.bytes_total);
    },
  });
  const transport = createModelTransport({
    command, part: getPart, online: isOnline, memberId: () => self()?.memberId ?? null, sleep,
    sizesOf: (offerId) => incoming.sizesOf(offerId), pausesOf: (id) => pauses.get(id) || 0, waitChange,
    partBytes, windowParts: L.windowParts,
  });
  const incoming = createModelIncoming({
    teamId, transport, hasher, roots, discovery, command, self, nameOf, log: say, timers, clock,
    defaultRoot: userDataPath ? path.join(userDataPath, 'models') : null,
    receiveLimits: { ...(options.receiveLimits || {}), partBytes },
    onChange: changed,
    onProgress: (take) => progress('receive', transport.transferOf(take.offerId), take.offerId, take.doneBytes, take.totalBytes),
    onReceived: (fields) => { if (!stopped) { try { push({ kind: 'received', team_id: teamId, ...fields }); } catch { /* best effort */ } } },
  });
  const unsubscribe = manager.onEvent(onEvent);
  listening = true;

  // A connect (the first, or a reconnect): roster, list, staging, offers the list does not show, receives the link cut.
  async function connected(first) {
    await readRoster();
    const list = await readList();
    if (stopped || !isOnline()) return;
    const me = self()?.memberId;
    if (first && list) await incoming.probe(list.offers.filter((summary) => summary.sender_member_id !== me && summary.state !== 'ended'));
    await sender.reconnected();
    incoming.reconnected();
  }

  // One connect run at a time; a connect that comes during one runs once more after it.
  let firstConnect = true;
  let connecting = null;
  let connectAgain = false;
  function runConnect() {
    if (connecting) { connectAgain = true; return; }
    const first = firstConnect;
    firstConnect = false;
    connecting = connected(first).catch(() => say('WARN', 'team.model.connect_failed')).finally(() => {
      connecting = null;
      if (connectAgain && !stopped && isOnline()) { connectAgain = false; runConnect(); }
      connectAgain = false;
    });
  }

  function connectionChanged() {
    if (stopped) return;
    const facts = row();
    const now = facts?.state === 'online' && facts.member_state === 'active';
    if (now && !online) {
      online = true;
      reconnects.reconnected();
      runConnect();
    } else if (!now && online) {
      online = false;
    }
    changed();
  }

  function stateOf() {
    const me = self()?.memberId ?? null;
    const transferRow = (view, direction) => {
      const done = direction === 'send' ? Math.max(view.bytes_done, sentDone.get(view.transfer_id) || 0) : view.bytes_done;
      const counterpart = direction === 'send' ? view.receiver_member_id : view.sender_member_id;
      return { transfer_id: view.transfer_id, member_id: counterpart, member_name: nameOf(counterpart), state: view.state,
        reason: rowReason(view.reason), queued: view.queued, bytes_done: done, bytes_total: view.bytes_total,
        rate_bps: meters.get(view.transfer_id)?.rate ?? 0 };
    };
    const outgoing = sender.records().map((record) => {
      const total = record.files.reduce((sum, file) => sum + file.size, 0);
      return {
        request_id: record.requestId, offer_id: record.offerId, tag: record.tag, display_name: record.displayName,
        audience: record.audience.kind, member_id: record.audience.member_id ?? null,
        member_name: record.audience.member_id ? nameOf(record.audience.member_id) : null,
        state: record.state, reason: rowReason(record.reason), files: record.files.length, total_bytes: total,
        read_done: record.read?.done ?? (record.manifest ? total : 0),
        transfers: [...views.values()].filter((view) => record.offerId && view.offer_id === record.offerId).map((view) => transferRow(view, 'send')),
      };
    });
    const incomingRows = [...offers.values()].filter((summary) => summary.sender_member_id !== me).map((summary) => {
      const take = incoming.takeOf(summary.offer_id);
      const transferId = transport.transferOf(summary.offer_id);
      const view = transferId ? views.get(transferId) : null;
      return {
        offer_id: summary.offer_id, sender_member_id: summary.sender_member_id, sender_name: nameOf(summary.sender_member_id),
        audience: summary.audience, display_name: summary.display_name, files: summary.files, total_bytes: summary.total_bytes,
        state: summary.state, reason: rowReason(summary.reason), offered_at: firstSeen.get(summary.offer_id) ?? null,
        transfer: take ? { transfer_id: transferId, state: take.state, reason: take.reason, queued: view?.queued === true,
          bytes_done: take.bytes_done, bytes_total: take.bytes_total, rate_bps: transferId ? meters.get(transferId)?.rate ?? 0 : 0,
          root_index: take.root_index } : null,
      };
    });
    return { sharing, sharing_reason: sharingReason, online: isOnline(), rate_mb_per_second: rateMb, outgoing, incoming: incomingRows };
  }

  // Every answer that is not this module's own success is rebuilt: a closed reason word, never host text.
  const answered = (answer) => (answer?.ok === true ? answer : modelFailure(answer));

  async function call(method, value) {
    if (stopped) return modelRefusal('team_disposed');
    if (!LOCAL_METHODS.has(method) && !isOnline()) return modelRefusal('team_not_connected');
    if (SENDS.has(method) && !RECEIVING_ROLES.has(row()?.role)) return modelRefusal('client_unauthorized');
    if ((method === 'modelOffer' || method === 'modelAccept') && sharing === 'off') return modelRefusal(sharingReason);
    switch (method) {
      case 'modelState':
        if (sharing === 'unknown' && isOnline()) await once('list', () => readList());
        return { ok: true, ...stateOf() };
      case 'modelSendable': return { ok: true, models: await sender.sendable() };
      case 'modelFiles': return answered(await sender.files(value.tag));
      case 'modelReceivers': {
        if (!await once('roster', () => readRoster())) return modelRefusal('team_not_connected');
        const me = self()?.memberId;
        return { ok: true, members: [...roster].filter(([id]) => id !== me).map(([id, member]) => ({ member_id: id,
          display_name: member.display_name, role: member.role, can_receive: RECEIVING_ROLES.has(member.role) && member.state === 'active' })) };
      }
      case 'modelOffer': return answered(await sender.offer(value));
      case 'modelWithdraw': return answered(await sender.withdraw(value.request_id));
      case 'modelSendPause': return answered(await sender.pause(value.transfer_id));
      case 'modelSendResume': return answered(await sender.resume(value.transfer_id));
      case 'modelSendStop': return answered(await sender.stop(value.transfer_id));
      case 'modelOfferRead':
        return answered(await once(`read:${value.offer_id}`, () => incoming.offerRead(value.offer_id, firstSeen.get(value.offer_id) ?? null)));
      case 'modelAccept': return answered(await incoming.accept(value.offer_id, value.root_index));
      case 'modelDecline': return answered(await incoming.decline(value.offer_id));
      case 'modelReceivePause': return answered(await incoming.pause(value.offer_id));
      case 'modelReceiveResume': return answered(await incoming.resume(value.offer_id));
      case 'modelReceiveCancel': return answered(await incoming.cancel(value.offer_id));
      case 'modelReceiveRetry': return answered(await incoming.retry(value.offer_id));
      case 'modelSetRate':
        rateMb = value.mb_per_second;
        if (!rateFile.save(rateMb)) say('WARN', 'team.model.rate_not_saved');
        changed();
        return { ok: true, mb_per_second: rateMb };
      case 'modelProvenance': return answered(await incoming.provenance(value.tag));
      default: return modelRefusal('team_request_invalid');
    }
  }

  /** At build: the sweep, the offers kept across a restart, and the connection as it is now. */
  function start() {
    incoming.startSweep();
    void sender.restore().catch(() => say('WARN', 'team.model.restore_failed'));
    connectionChanged();
  }

  /** Ends every read, push and receive (staging kept), every wait and timer, and the event listener. */
  // Every caller of `stop` waits for the same stop.
  let stopping = null;
  function stop() {
    stopping ??= (async () => {
      stopped = true;
      unsubscribe();
      listening = false;
      await Promise.allSettled([sender.stopAll(), incoming.dispose(), connecting]);
      for (const waiter of [...changeWaiters]) waiter.done();
      for (const handle of [...pending]) cancelLater(handle);
      stateTimer = null;
    })();
    return stopping;
  }

  return Object.freeze({
    call, start, stop, connectionChanged, manager,
    // What this entry holds that must be gone after `stop`: each counted where it is made or ended.
    resources: () => {
      const sending = sender.resources();
      const receiving = incoming.resources();
      return { pushes: sending.pushes, reads: sending.reads, handles: receiving.handles, receiving: receiving.active,
        timers: pending.size + receiving.sweepTimers, waits: changeWaiters.size + reconnects.size(), listeners: listening ? 1 : 0,
        connecting: connecting ? 1 : 0 };
    },
  });
}

module.exports = { createModelTeam };
