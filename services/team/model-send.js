'use strict';

// The model sender for one team on a member's PC (row 123 slice 6-5, decisions 4 and 5; TEAM_MODEL_SHARING_SPEC
// "The sender"). An offer names a discovery tag and the ticked companion files (model-send-source.js checks them
// and the manifest before any hashing), then the files are read once by the team module's one hasher (one read of
// this sender at a time, with progress and an abort signal; a busy hasher is waited for, never an end), the manifest
// is built with the real digests, kept in the offers file (model-offers-file.js) and sent as `team.model.offer` with
// a request id kept with it. At most 16 open offers (`team_model_offer_limit`), the slot taken before the first wait.
//
// Every reconnect re-sends each open offer the host's list does not show, with the SAME request id and body (the host
// forgets an absent sender after 120 s; the relay is idempotent by request id); one send of an offer at a time, and a
// rate-limited send is tried again after 20 s (one timer, ended by `stopAll`). Kept offers read back at build are each
// re-read before they are offered again; until its read ends a kept entry stays in the file as it was loaded, and a
// discovery scan that failed (not one that answered) keeps every entry for the next reconnect.
//
// Transfers of its offers come from the module's list and events; each accepted transfer gets one push
// (model-send-push.js): one part at a time, the source re-stated before each part. A changed source ends the push
// with `model_source_changed`, the host gets a plain cancel, and the offer is withdrawn (every later accept would fail
// the hash). Pause, resume and stop per transfer; withdraw per offer; `stopAll` ends every read and push and waits
// for them. A host answer is rebuilt before it is answered or kept (model-answers.js); logs carry event names, ids,
// counts, sizes and closed reason words: never a path, file name, hash, licence text, URL or note. Nothing here loads
// a model or writes a setting. The last 16 ended or failed offers are kept for the state; older ones are dropped.

const crypto = require('node:crypto');
const fs = require('node:fs');

const { MODEL_TRANSFER_LIMITS } = require('../../server/team/model-manifest');
const { MODEL_RELAY_ID_PATTERNS } = require('../../server/team/model-relay-core');
const { modelFailure } = require('./model-answers');
const { modelRefusal, rowReason } = require('./model-reasons');
const { createPush } = require('./model-send-push');
const { buildManifest, cleanText, cleanUrl, identityOf, precheck, provenancePrefill, resolveModel, sameIdentity,
  sendableModels } = require('./model-send-source');

const LIMITS = MODEL_TRANSFER_LIMITS;
const OPEN = new Set(['reading', 'offering', 'open', 'taken']);
const LIVE = new Set(['accepted', 'flowing', 'paused']);
const QUIET = new Set(['team_not_connected', 'team_connection_stopped', 'host_unavailable']);
const KEPT_ENDED = 16;
const RATE_RETRY_MS = 20_000;
const BUSY_WAIT_MS = 1000;
const fsImpl = fs;

const refuse = modelRefusal;
const newRequestId = () => `m${crypto.randomBytes(16).toString('base64url')}`;
const word = (reason) => (reason == null ? null : (rowReason(reason) ?? 'team_unavailable'));
const failed = (reason) => Object.assign(new Error(reason), { reason });

/**
 * deps: `teamId`, `discovery()` (the late-bound `listLocalGgufs`; a failed scan throws), `hasher`, `self()` ({ memberId,
 * displayName } from the roster), `offersFile`, `link` ({ command, put, online, waitReconnect }), `transfers`
 * ({ view(id), pauses(id), refresh(signal), waitView(id, signal, ms), replay(offerId) }), `limiter`, `sleep`,
 * `partBytes`, `onChange()`, `onProgress(id, at, n)`, `log`.
 */
function createModelSender({
  teamId, discovery, hasher, self, offersFile, link, transfers, limiter, sleep, partBytes = LIMITS.partBytes,
  onChange = () => {}, onProgress = () => {}, log = () => {},
}) {
  const offers = new Map(); // request id -> record
  const pushes = new Map(); // transfer id -> { requestId, controller, task, state, reason }
  const reads = new Set();
  const hostOffers = new Map(); // offer id -> 'open' | 'taken', as the host's last list and events show it
  const parked = []; // kept entries a failed scan could not resolve: kept in the file, tried at the next reconnect
  let reserved = 0; // offers past their slot check, not yet recorded
  let readChain = Promise.resolve();
  let retrying = null; // the rate-limited send's one retry
  let stopped = false;
  const say = (level, event, fields = {}) => { try { log(level, event, { team_id: teamId, ...fields }); } catch { /* best effort */ } };
  const changed = () => { if (!stopped) { try { onChange(); } catch { /* best effort */ } } };

  function persist() {
    const entries = [];
    for (const record of offers.values()) {
      if (!OPEN.has(record.state)) continue;
      if (record.manifest) {
        entries.push({ request_id: record.requestId, offer_id: record.offerId, audience: record.audience, tag: record.tag,
          files: record.manifest.files.map((file) => file.name), manifest: record.manifest });
      } else if (record.kept) entries.push({ ...record.kept, offer_id: record.offerId });
    }
    for (const entry of parked) if (!entries.some((kept) => kept.request_id === entry.request_id)) entries.push(entry);
    const saved = offersFile.save(entries.slice(0, LIMITS.maxOffersPerMember));
    if (!saved.ok) say('WARN', 'team.model.offers_not_saved', { reason: word(saved.reason) });
  }

  // The last KEPT_ENDED ended or failed offers stay listed; older ones go.
  function pruneEnded() {
    const done = [...offers.values()].filter((record) => !OPEN.has(record.state));
    for (const record of done.slice(0, Math.max(0, done.length - KEPT_ENDED))) offers.delete(record.requestId);
  }

  function end(record, state, reason) {
    record.controller?.abort();
    record.state = state;
    record.reason = word(reason);
    record.kept = null;
    persist();
    for (const push of pushes.values()) if (push.requestId === record.requestId) push.controller.abort();
    say('INFO', 'team.model.offer_ended', { offer_id: record.offerId, state, reason: record.reason });
    pruneEnded();
    changed();
  }

  // One read of this sender at a time: a kept offer's re-read and a new offer's read queue behind each other.
  function serial(work) {
    const run = readChain.then(work);
    readChain = run.catch(() => {});
    reads.add(run);
    void run.catch(() => {}).finally(() => reads.delete(run));
    return run;
  }

  async function hashOf(record, file, base) {
    for (;;) {
      if (record.controller.signal.aborted) throw failed('aborted');
      try {
        return await hasher.hash(file.path, { signal: record.controller.signal,
          onProgress: (bytes) => {
            const before = record.read.done;
            record.read.done = base + bytes;
            // The rows repaint when the whole percent moves, not on every tick of the hasher.
            if (Math.floor((record.read.done * 100) / record.read.total) !== Math.floor((before * 100) / record.read.total)) changed();
          } });
      } catch (error) {
        if (record.controller.signal.aborted) throw failed('aborted');
        if (error?.code !== 'model_hash_busy') throw failed(error?.code === 'model_hash_changed' ? 'model_source_changed' : 'model_read_failed');
      }
      // Another team's read or a receiver's check holds the hasher: wait, never end the offer.
      try { await sleep(BUSY_WAIT_MS, record.controller.signal); } catch { throw failed('aborted'); }
    }
  }

  // Reads every file once (the hasher's cache makes an unchanged file free); answers the hashes or throws a reason.
  async function readFiles(record) {
    if (record.controller.signal.aborted || stopped) throw failed('aborted');
    const hashes = [];
    record.read = { done: 0, total: record.files.reduce((sum, file) => sum + file.size, 0) };
    let base = 0;
    for (const file of record.files) {
      const before = identityOf(await fsImpl.promises.lstat(file.path, { bigint: true }));
      if (Number(before.size) !== file.size) throw failed('model_source_changed');
      const result = await hashOf(record, file, base);
      const afterStat = identityOf(await fsImpl.promises.lstat(file.path, { bigint: true }));
      if (!sameIdentity(before, afterStat) || result.size !== file.size) throw failed('model_source_changed');
      file.identity = afterStat;
      base += file.size;
      record.read.done = base;
      hashes.push({ sha256: result.sha256, segments: result.segments });
    }
    return hashes;
  }

  const hostShows = (record) => Boolean(record.offerId) && hostOffers.has(record.offerId);

  // The host still holds this offer (its list or an event says so): no send, the state follows the host's.
  function followHost(record) {
    const state = hostOffers.get(record.offerId);
    if (record.state !== state) { record.state = state; changed(); }
  }

  function retryLater() {
    if (retrying || stopped) return;
    const controller = new AbortController();
    retrying = controller;
    sleep(RATE_RETRY_MS, controller.signal).then(async () => {
      if (retrying === controller) retrying = null;
      for (const record of [...offers.values()]) if (record.manifest && record.state === 'offering') await sendOffer(record);
    }, () => { if (retrying === controller) retrying = null; });
  }

  async function sendOffer(record) {
    if (stopped || !OPEN.has(record.state) || !link.online() || record.sending) return;
    record.sending = true;
    let answer;
    try {
      answer = await link.command('team.model.offer', record.manifest);
    } catch {
      return; // no answer: the next reconnect sends the same offer again
    } finally {
      record.sending = false;
    }
    if (stopped) return;
    if (!OPEN.has(record.state)) {
      // Ended while the first command was out: the host now holds an offer nobody knows, so it is withdrawn.
      const late = answer?.ok === true ? answer.offer?.offer_id : null;
      if (typeof late === 'string' && MODEL_RELAY_ID_PATTERNS.offer.test(late)) await link.command('team.model.withdraw', { offer_id: late }).catch(() => null);
      return;
    }
    if (answer?.ok === true) {
      const offerId = answer.offer?.offer_id;
      if (typeof offerId !== 'string' || !MODEL_RELAY_ID_PATTERNS.offer.test(offerId)) { end(record, 'failed', 'team_answer_invalid'); return; }
      if (record.offerId !== offerId) { record.offerId = offerId; persist(); }
      if (record.state === 'offering') record.state = answer.offer.state === 'taken' ? 'taken' : 'open';
      say('INFO', 'team.model.offered', { offer_id: record.offerId, files: record.manifest.files.length });
      changed();
      return;
    }
    const reason = modelFailure(answer).error.reason;
    if (QUIET.has(reason)) return;
    if (reason === 'team_rate_limit') { retryLater(); return; }
    end(record, 'failed', reason);
  }

  // A read done: the manifest kept, then the offer sent unless the host still holds it.
  async function offerRead(record, manifest) {
    record.manifest = manifest;
    record.kept = null;
    record.state = 'offering';
    record.read = null;
    persist();
    changed();
    if (hostShows(record)) followHost(record); else await sendOffer(record);
    // A transfer accepted while the files were read had no manifest to push from: the views known now start it.
    if (!stopped && OPEN.has(record.state) && record.offerId) transfers.replay(record.offerId);
  }

  function prepare(record) {
    void serial(async () => {
      try {
        const hashes = await readFiles(record);
        if (stopped || record.state !== 'reading') return;
        await offerRead(record, buildManifest({ requestId: record.requestId, audience: record.audience,
          displayName: record.displayName, files: record.files, provenance: record.provenance, hashes }));
      } catch (error) {
        if (error?.reason === 'aborted' || stopped || record.state !== 'reading') return;
        end(record, 'failed', error?.reason || 'model_read_failed');
      }
    });
  }

  const openCount = () => [...offers.values()].filter((record) => OPEN.has(record.state)).length;

  /** An offer: checked at once (no hashing yet); the read, the offer and the push go on after the answer. */
  async function offer(input) {
    if (stopped) return refuse('team_disposed');
    if (openCount() + parked.length + reserved >= LIMITS.maxOffersPerMember) return refuse('team_model_offer_limit');
    reserved += 1;
    try {
      const resolved = await resolveModel(discovery, input.tag, { fsImpl });
      if (stopped) return refuse('team_disposed');
      if (!resolved.ok) return refuse(resolved.reason);
      const chosen = new Set(input.files);
      const allowed = new Set(resolved.files.map((file) => file.name));
      if ([...chosen].some((name) => !allowed.has(name))) return refuse('model_file_not_offered');
      const files = resolved.files.filter((file) => file.required || chosen.has(file.name));
      const me = self();
      if (!me) return refuse('team_not_connected');
      const audience = input.member_id ? { kind: 'member', member_id: input.member_id } : { kind: 'team' };
      if (audience.kind === 'member' && audience.member_id === me.memberId) return refuse('model_audience_invalid');
      const record = {
        requestId: newRequestId(), offerId: null, audience, tag: resolved.tag, state: 'reading', reason: null,
        displayName: cleanText(input.display_name, LIMITS.maxDisplayNameChars),
        provenance: { licence: cleanText(input.licence ?? '', LIMITS.maxLicenceChars, { lines: true }),
          source_url: input.source_url ? cleanUrl(input.source_url) : '', note: cleanText(input.note ?? '', LIMITS.maxNoteChars, { lines: true }) },
        files: files.map((file) => ({ name: file.name, size: file.size, path: file.path, identity: null })),
        manifest: null, kept: null, controller: new AbortController(), read: null, sending: false,
      };
      if (input.source_url && !record.provenance.source_url) return refuse('model_manifest_invalid');
      const draft = buildManifest({ requestId: record.requestId, audience, displayName: record.displayName, files: record.files,
        provenance: record.provenance });
      const checked = precheck({ manifest: draft, teamId, sender: me });
      if (!checked.ok) return refuse(checked.reason);
      offers.set(record.requestId, record);
      say('INFO', 'team.model.offer_reading', { files: files.length, bytes: files.reduce((sum, file) => sum + file.size, 0) });
      changed();
      prepare(record);
      return { ok: true, request_id: record.requestId };
    } finally {
      reserved -= 1;
    }
  }

  // Kept entries against one answered scan: each resolved, then re-read (queued) before it is offered again.
  async function restoreEntries(entries, list) {
    const scan = async () => list;
    for (const entry of entries) {
      if (stopped) return;
      if (offers.has(entry.request_id)) continue;
      const record = { requestId: entry.request_id, offerId: entry.offer_id, audience: entry.audience, tag: entry.tag,
        state: 'reading', reason: null, displayName: entry.manifest.display_name, provenance: { ...entry.manifest.provenance },
        files: [], manifest: null, kept: entry, controller: new AbortController(), read: null, sending: false };
      offers.set(record.requestId, record);
      const resolved = await resolveModel(scan, entry.tag, { fsImpl });
      if (stopped) return;
      const byName = new Map((resolved.ok ? resolved.files : []).map((file) => [file.name, file]));
      if (!entry.files.every((name) => byName.has(name))) { end(record, 'failed', 'model_not_listed'); continue; }
      record.files = entry.manifest.files.map((file) => ({ name: file.name, size: file.size, path: byName.get(file.name).path, identity: null }));
      void serial(async () => {
        try {
          const hashes = await readFiles(record);
          if (stopped || record.state !== 'reading') return;
          const same = hashes.every((hash, index) => hash.sha256 === entry.manifest.files[index].sha256);
          if (!same) { end(record, 'failed', 'model_source_changed'); return; }
          await offerRead(record, entry.manifest);
        } catch (error) {
          if (error?.reason !== 'aborted' && !stopped && record.state === 'reading') end(record, 'failed', error?.reason || 'model_read_failed');
        }
      });
    }
  }

  // One scan for a batch of kept entries; a scan that failed keeps them all for the next reconnect.
  async function restoreFromScan(entries) {
    let list;
    try { list = await discovery(); } catch { list = null; }
    if (stopped) return;
    if (!Array.isArray(list)) {
      parked.push(...entries.filter((entry) => !parked.some((kept) => kept.request_id === entry.request_id)));
      say('WARN', 'team.model.restore_deferred', { offers: entries.length });
      return;
    }
    await restoreEntries(entries, list);
  }

  /** The offers file read back at build: each entry re-resolved and re-read before it is offered again. */
  async function restore() {
    const kept = offersFile.load();
    if (kept.length > 0) await restoreFromScan(kept);
  }

  /** The host's list: the offers it holds now (a reconnect, a resync). */
  function listed(summaries) {
    hostOffers.clear();
    for (const summary of summaries) if (summary.state !== 'ended') hostOffers.set(summary.offer_id, summary.state);
  }

  /** Every open offer the host's list does not show, again with the same request id and body (a reconnect). */
  async function reconnected() {
    if (parked.length > 0 && !stopped) await restoreFromScan(parked.splice(0));
    for (const record of [...offers.values()]) {
      if (stopped) return;
      if (!record.manifest || !OPEN.has(record.state)) continue;
      if (hostShows(record)) { followHost(record); continue; }
      if (record.state === 'open' || record.state === 'taken') record.state = 'offering';
      await sendOffer(record);
    }
  }

  const recordOfOffer = (offerId) => [...offers.values()].find((record) => record.offerId === offerId) || null;

  /** A summary of an offer (a list's or an event's): the host's word on one of this member's offers. */
  function offerSeen(summary) {
    if (summary.state === 'ended') hostOffers.delete(summary.offer_id); else hostOffers.set(summary.offer_id, summary.state);
    const record = recordOfOffer(summary.offer_id);
    if (!record || !OPEN.has(record.state)) return;
    if (summary.state === 'ended') { end(record, 'ended', summary.reason); return; }
    if (record.state === 'reading') return; // its read decides what comes next
    const state = summary.state === 'taken' ? 'taken' : 'open';
    if (record.state !== state) { record.state = state; changed(); }
  }

  /** A transfer view of one of this member's offers: starts its push while it is live. */
  function transferSeen(view) {
    const record = recordOfOffer(view.offer_id);
    if (!record || !record.manifest || stopped) return;
    if (!LIVE.has(view.state) || pushes.has(view.transfer_id)) return;
    const controller = new AbortController();
    const entry = { requestId: record.requestId, controller, task: null, state: 'pushing', reason: null };
    pushes.set(view.transfer_id, entry);
    const push = createPush({ transferId: view.transfer_id, files: record.files, partBytes, fsImpl,
      put: (index, n, bytes, signal) => link.put(view.transfer_id, index, n, bytes, signal),
      command: link.command, view: () => transfers.view(view.transfer_id), pauses: () => transfers.pauses(view.transfer_id),
      refresh: (signal) => transfers.refresh(signal), waitView: (signal, ms) => transfers.waitView(view.transfer_id, signal, ms),
      online: link.online, waitReconnect: link.waitReconnect, sleep, limiter,
      onProgress: (at, bytes) => onProgress(view.transfer_id, at, bytes) });
    entry.task = push.run(controller.signal).then(async (outcome) => {
      entry.state = outcome.state;
      entry.reason = word(outcome.reason);
      say('INFO', 'team.model.push_ended', { transfer_id: view.transfer_id, state: outcome.state, reason: entry.reason });
      if (outcome.reason === 'model_source_changed') {
        await link.command('team.model.cancel', { transfer_id: view.transfer_id }).catch(() => null);
        if (record.offerId) await link.command('team.model.withdraw', { offer_id: record.offerId }).catch(() => null);
        end(record, 'failed', 'model_source_changed');
      }
      // Gone from the map whatever the end: a later view of a live transfer (a list after a reconnect) starts it again.
      pushes.delete(view.transfer_id);
      changed();
    });
  }

  async function withdraw(requestId) {
    const record = offers.get(requestId);
    if (!record || !OPEN.has(record.state)) return refuse('team_not_found');
    if (record.offerId) {
      let answer;
      try { answer = await link.command('team.model.withdraw', { offer_id: record.offerId }); } catch { answer = null; }
      if (!answer) return refuse('team_not_connected');
      if (answer.ok !== true && modelFailure(answer).error.reason !== 'team_not_found') return modelFailure(answer);
    }
    if (OPEN.has(record.state)) end(record, 'ended', 'withdrawn');
    return { ok: true };
  }

  // Pause, resume or stop one of this member's transfers (the host checks the party).
  async function transferCall(operation, transferId) {
    const push = pushes.get(transferId);
    const view = transfers.view(transferId);
    if (!push && !(view && recordOfOffer(view.offer_id))) return refuse('team_not_found');
    let answer;
    try { answer = await link.command(operation, { transfer_id: transferId }); } catch { answer = null; }
    if (!answer) return refuse('team_not_connected');
    if (answer.ok !== true) return modelFailure(answer);
    if (operation === 'team.model.cancel') push?.controller.abort();
    return { ok: true };
  }

  async function stopAll() {
    stopped = true;
    retrying?.abort();
    for (const record of offers.values()) record.controller?.abort();
    for (const push of pushes.values()) push.controller.abort();
    await Promise.allSettled([...reads, ...[...pushes.values()].map((push) => push.task)]);
  }

  return Object.freeze({
    sendable: () => sendableModels(discovery),
    files: async (tag) => {
      const resolved = await resolveModel(discovery, tag, { fsImpl });
      if (!resolved.ok) return refuse(resolved.reason);
      const main = resolved.files.find((file) => file.name === resolved.main);
      return { ok: true, tag: resolved.tag, files: resolved.files.map(({ name, size, kind, required }) => ({ name, size_bytes: size, kind, required })),
        provenance: provenancePrefill(main.path, resolved.tag) };
    },
    offer, restore, listed, reconnected, offerSeen, transferSeen, withdraw,
    pause: (transferId) => transferCall('team.model.pause', transferId),
    resume: (transferId) => transferCall('team.model.resume', transferId),
    stop: (transferId) => transferCall('team.model.cancel', transferId),
    records: () => [...offers.values()],
    stopAll,
    resources: () => ({ offers: openCount(), pushes: pushes.size, reads: reads.size }),
  });
}

module.exports = { createModelSender };
