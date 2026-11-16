'use strict';

// The receiving side of one team's model sharing on a member's PC (row 123 slice 6-5, decision 6): one model receiver
// (6-4's model-receive.js) over the network transport (model-transport.js), the accept screen's facts (the offer's
// files, sizes and digests, the roots with their free space, whether the set fits and whether a file of that name is
// there), accept, decline, pause, resume, cancel and retry, the staging found at build for each open incoming offer,
// the 7-day sweep (daily on a timer that lives only as long as this module; the sweep at start is team-models.js's),
// and a received model's provenance file. The receiver takes one transfer at a time: a second accept answers
// `model_receiver_busy`. Cancel or Decline of a take that is not the receiver's removes its staging too (R14-F02).
// Accept, retry and resume each take one claim before their first wait and give it back on every exit, so two calls
// in one tick never both reach the receiver. An accept is bound to what the accept screen showed for that offer: the
// root path at the chosen index and a fingerprint of the manifest (a changed one is refused).
//
// A transfer cut by the link pauses as `model_transfer_interrupted` and is resumed at the next reconnect unless the
// member paused it. A host refusal at accept (the offer taken, the sender offline) is kept as the row's reason; when
// nothing was pulled yet the receiver's fresh staging is cancelled at once, so the slot is free. Logs and pushes carry
// ids, states, sizes and reason words; the only path an answer carries is a root's display path in the roots list.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { readJson } = require('../host/durable-json');
const { MODEL_TRANSFER_LIMITS, PROVENANCE_SUFFIX, mainModelName } = require('../../server/team/model-manifest');
const { samePath } = require('../../server/team/file-checks');
const { isCleanText } = require('../../server/team/member-schema');
const { createModelReceiver } = require('./model-receive');
const { freeBytesOf, placedAnywhere } = require('./model-receive-checks');
const { INCOMING_DIR, transferIdFor } = require('./model-receive-journal');
const { offerWithManifest } = require('./model-answers');
const { modelRefusal, rowReason } = require('./model-reasons');

const L = MODEL_TRANSFER_LIMITS;
const DAY_MS = 24 * 60 * 60 * 1000;
const PROBE_READS = 8;
// The accept screens remembered (offer id -> the roots and the manifest it showed): at most one per open offer.
const MAX_READS = L.maxOffersPerHost;
const SHA = /^[0-9a-f]{64}$/u;
// Provenance text from disk: control characters out (a line feed and a tab kept in the licence and the note).
const CONTROL = /\p{Cc}/gu;
const LINE_CONTROL = /(?![\n\t])\p{Cc}/gu;
const fingerprintOf = (manifest) => crypto.createHash('sha256').update(JSON.stringify(manifest)).digest('hex');
// Host words that mean the offer cannot be taken now: the fresh staging of an accept that pulled nothing goes.
const KEEP_STAGING = new Set(['team_not_connected', 'team_connection_stopped', 'model_transfer_interrupted']);
const RUNNING = new Set(['pulling', 'verifying', 'placing']);

/**
 * deps: `teamId`, `transport` (model-transport.js), `hasher`, `roots()` ([{ path, display }], the discovery roots),
 * `discovery()` (the listing), `command(operation, params)`, `self()`, `nameOf(memberId)`,
 * `onChange()`, `onProgress(take)`, `onReceived({ tag, root_index })`, `log`, `timers`, `clock`, `receiveLimits`,
 * `defaultRoot` ({userData}/models: the one root an accept may make).
 */
function createModelIncoming({
  teamId, transport, hasher, roots, discovery, command, self, nameOf, onChange = () => {}, onProgress = () => {},
  onReceived = () => {}, log = () => {}, timers = { setInterval, clearInterval }, clock = Date.now, receiveLimits = {},
  defaultRoot = null,
}) {
  const takes = new Map(); // offer id -> { offerId, manifest, rootIndex, rootPath, state, reason, doneBytes, totalBytes, hostReason, userPaused }
  const reads = new Map(); // offer id -> { paths, fingerprint } (what the accept screen showed)
  let current = null; // the take the receiver holds
  let claimed = false; // an accept, retry or resume between its first wait and its answer
  let runOnLater = false; // a run-on asked for while the claim was held: looked at again once it is given back
  let disposed = false;
  const say = (level, event, fields = {}) => { try { log(level, event, { team_id: teamId, ...fields }); } catch { /* best effort */ } };
  const rootPaths = () => roots().map((root) => root.path);

  // The transport, with the host's reason of a failed call kept on the take (the receiver only sees "interrupted"):
  // the first one, not a follow-up call's (the pause the receiver sends after a failed part).
  const noted = (name) => async (payload) => {
    try {
      return await transport[name](payload);
    } catch (error) {
      const take = takes.get(payload.offerId);
      if (take && !take.hostReason && typeof error?.code === 'string' && error.code !== 'aborted') take.hostReason = rowReason(error.code);
      throw error;
    }
  };
  const wrapped = { accept: noted('accept'), resume: noted('resume'), takePart: noted('takePart'), pause: noted('pause'),
    cancel: noted('cancel'), complete: noted('complete') };

  const receiver = createModelReceiver({
    roots: rootPaths, transport: wrapped, hasher, clock, limits: receiveLimits,
    logger: (level, event, fields) => say(level, event, fields),
    onEvent: (event) => {
      const take = current;
      if (!take) return;
      take.state = event.state;
      take.reason = event.reason;
      take.doneBytes = event.doneBytes;
      take.totalBytes = event.totalBytes;
      // The folder the set goes into; on `complete` the one it went into (R14-F01).
      take.folder = receiver.folder() ?? take.folder;
      // The call answers once the host's accept (or resume) is past and bytes flow; a pause or an end answers through
      // the run's outcome instead (a host refusal at accept arrives as an interrupted pause).
      if (RUNNING.has(event.state)) { take.ran = true; take.onFirst?.(); }
      if (event.state === 'pulling' || event.state === 'verifying') onProgress(take);
      onChange();
    },
  });

  function rootsFor(manifest) {
    const main = mainModelName(manifest);
    const total = manifest.files.reduce((sum, file) => sum + file.size, 0);
    return roots().map((root, index) => {
      const free = freeBytesOf(root.path);
      // A file of that name in any folder the set could go into (the receiver's model_exists).
      const exists = placedAnywhere(root.path, manifest, main);
      return { index, display_path: root.display, free_bytes: free, fits: free === null || free >= total + L.freeSpaceMarginBytes, exists };
    });
  }

  async function readOffer(offerId) {
    let answer;
    try { answer = await command('team.model.offer.read', { offer_id: offerId }); } catch { return { failure: modelRefusal('team_not_connected') }; }
    if (answer?.ok !== true) return { failure: modelRefusal(answer?.error?.reason) };
    const read = offerWithManifest(answer);
    return read ? read : { failure: modelRefusal('team_answer_invalid') };
  }

  /** The accept screen: files, sizes, the total, each file's SHA-256, the sender's words, when offered, and the roots. */
  async function offerRead(offerId, offeredAt) {
    const read = await readOffer(offerId);
    if (read.failure) return read.failure;
    const { summary, manifest } = read;
    reads.delete(offerId);
    reads.set(offerId, { paths: rootPaths(), fingerprint: fingerprintOf(manifest) });
    while (reads.size > MAX_READS) reads.delete(reads.keys().next().value);
    return {
      ok: true,
      offer: {
        offer_id: summary.offer_id, sender_member_id: summary.sender_member_id, sender_name: nameOf(summary.sender_member_id),
        audience: summary.audience, display_name: manifest.display_name, state: summary.state, offered_at: offeredAt,
        files: manifest.files.map((file) => ({ name: file.name, size_bytes: file.size, sha256: file.sha256 })),
        total_bytes: summary.total_bytes,
        provenance: { licence: manifest.provenance.licence, source_url: manifest.provenance.source_url, note: manifest.provenance.note },
      },
      roots: rootsFor(manifest),
    };
  }

  // One accept, retry or resume at a time: the claim is taken before the first wait and given back on every exit.
  async function claim(work) {
    if (claimed) return modelRefusal('model_receiver_busy');
    claimed = true;
    try { return await work(); } finally {
      claimed = false;
      if (runOnLater) { runOnLater = false; queueMicrotask(reconnected); }
    }
  }

  // Runs the receiver from `start` (or `resume`) until it reports a running state or ends; answers the IPC call then.
  // A live take of the receiver is never replaced.
  async function drive(take, run) {
    if (current && current !== take) return modelRefusal('model_receiver_busy');
    current = take;
    const started = new Promise((resolve) => { take.onFirst = () => { take.onFirst = null; resolve({ running: true }); }; });
    const ended = run().then((outcome) => ({ outcome }), () => ({ outcome: { ok: false, reason: 'model_staging_failed' } }));
    void ended.then(({ outcome }) => settle(take, outcome));
    const first = await Promise.race([started, ended]);
    take.onFirst = null;
    // The answer carries no folder name (E82); the take keeps it for the announce and the provenance file records it.
    const done = () => ({ ok: true });
    if (first.running) return done();
    const { outcome } = first;
    if (outcome.state === undefined) { forget(take); return modelRefusal(outcome.reason); }
    // The host refused a fresh accept (the sender offline, the offer taken): the call answers that refusal.
    if (refusedAtAccept(take, outcome)) return modelRefusal(take.hostReason);
    return outcome.ok || outcome.state === 'paused' ? done() : modelRefusal(outcome.reason || take.hostReason);
  }

  // An accept (or a retry's accept) the host refused before the take ever ran: the receiver saw only an interrupted
  // pause. A take that ran once (a resume after a reconnect while the sender is still away) is never this.
  const refusedAtAccept = (take, outcome) => outcome.state === 'paused' && outcome.reason === 'model_transfer_interrupted'
    && !take.userPaused && !take.ran && Boolean(take.hostReason) && !KEEP_STAGING.has(take.hostReason);

  // A take leaves the list only if it is still the one listed for its offer.
  const unlist = (take) => { if (takes.get(take.offerId) === take) takes.delete(take.offerId); };

  // The end of a run (or its pause): placed models are announced once; a fresh accept the host refused frees the slot.
  async function settle(take, outcome) {
    if (outcome.state === undefined) return;
    if (outcome.state === 'complete') {
      if (current === take) current = null;
      unlist(take);
      await announce(take);
    } else if (refusedAtAccept(take, outcome) && take.fresh && take.doneBytes === 0) {
      take.reason = take.hostReason;
      await receiver.cancel();
      if (current === take) current = null;
      take.state = 'failed';
      take.reason = take.hostReason;
    } else if (['failed', 'cancelled', 'disposed'].includes(outcome.state)) {
      if (current === take) current = null;
      if (outcome.state !== 'failed') unlist(take);
    }
    onChange();
  }

  async function announce(take) {
    const main = mainModelName(take.manifest);
    const dir = path.join(take.rootPath, take.folder || '');
    let tag = null;
    try {
      const entry = (await discovery({ fresh: true })).find((row) => row?.mainGguf === main && path.resolve(String(row.dir || '')) === path.resolve(dir));
      tag = typeof entry?.tag === 'string' ? entry.tag : null;
    } catch { /* tag stays null */ }
    say('INFO', 'team.model.received', { offer_id: take.offerId, files: take.manifest.files.length });
    try { onReceived({ tag, root_index: take.rootIndex }); } catch { /* best effort */ }
  }

  // A take that never started (or was cancelled) goes; another take of the same offer, or the receiver's, stays.
  function forget(take) {
    if (current === take) current = null;
    unlist(take);
    onChange();
  }

  async function startTake(offerId, rootIndex, rootPath, manifest, summary, { fresh = true } = {}) {
    // Only {userData}/models is made when missing, with one plain mkdir (never recursive); another missing root is
    // refused and never made (R14-F08). The receiver's own checks decide the rest.
    if (!fs.existsSync(rootPath)) {
      if (!defaultRoot || !samePath(path.resolve(rootPath), path.resolve(defaultRoot))) return modelRefusal('model_root_invalid');
      try { fs.mkdirSync(rootPath); } catch { /* the accept checks refuse it */ }
    }
    const me = self();
    const senderName = nameOf(summary.sender_member_id);
    if (!me || !isCleanText(senderName, L.maxDisplayNameChars)) return modelRefusal('team_not_connected');
    if (disposed) return modelRefusal('team_disposed');
    const take = { offerId, senderId: summary.sender_member_id, manifest, rootIndex, rootPath, state: 'accepting', reason: null, doneBytes: 0,
      totalBytes: manifest.files.reduce((sum, file) => sum + file.size, 0), hostReason: null, userPaused: false, onFirst: null, fresh, ran: false };
    takes.set(offerId, take);
    onChange();
    return drive(take, () => receiver.start({
      offer: { offerId, teamId, sender: { memberId: summary.sender_member_id, displayName: senderName }, manifest }, root: rootPath }));
  }

  // The root at `rootIndex` as the accept screen showed it, and the manifest unchanged since: a refusal or the root path.
  // No remembered accept screen (never read, evicted, or the offer ended) is a refusal, so the screen reads again (R14-F06).
  function boundRoot(offerId, rootIndex, manifest) {
    const root = roots()[rootIndex];
    if (!root) return { failure: modelRefusal('model_root_invalid') };
    const seen = reads.get(offerId);
    if (!seen || seen.fingerprint !== fingerprintOf(manifest)) return { failure: modelRefusal('model_manifest_invalid') };
    if (seen.paths[rootIndex] !== root.path) return { failure: modelRefusal('model_root_invalid') };
    return { rootPath: root.path };
  }

  function accept(offerId, rootIndex) {
    if (disposed) return Promise.resolve(modelRefusal('team_disposed'));
    return claim(async () => {
      if (current) return modelRefusal('model_receiver_busy');
      const read = await readOffer(offerId);
      if (read.failure) return read.failure;
      const bound = boundRoot(offerId, rootIndex, read.manifest);
      if (bound.failure) return bound.failure;
      return startTake(offerId, rootIndex, bound.rootPath, read.manifest, read.summary);
    });
  }

  // A take that is not the receiver's (found after a restart, or failed): its staging and journal go as the current
  // take's cancel removes them, under the claim (R14-F02). A refusal when they cannot, and the row stays.
  function discardTake(take) {
    return claim(async () => {
      if (takes.get(take.offerId) !== take || current === take) return modelRefusal('model_receiver_busy');
      if (roots()[take.rootIndex]?.path !== take.rootPath) return modelRefusal('model_root_invalid');
      // The staging folder is found by the team, the sender and the files; the display name plays no part.
      const offer = { offerId: take.offerId, teamId, sender: { memberId: take.senderId, displayName: 'member' }, manifest: take.manifest };
      const answer = await receiver.discard({ offer, root: take.rootPath });
      if (!answer.ok) return modelRefusal(answer.reason);
      unlist(take);
      onChange();
      return { ok: true };
    });
  }

  async function decline(offerId) {
    if (current?.offerId === offerId) return modelRefusal('model_receiver_busy');
    const take = takes.get(offerId);
    if (take) {
      const discarded = await discardTake(take);
      if (!discarded.ok) return discarded;
    }
    let answer;
    try { answer = await command('team.model.decline', { offer_id: offerId }); } catch { return modelRefusal('team_not_connected'); }
    if (answer?.ok !== true) return modelRefusal(answer?.error?.reason);
    takes.delete(offerId);
    onChange();
    return { ok: true };
  }

  async function pause(offerId) {
    if (current?.offerId !== offerId) return modelRefusal('model_not_receiving');
    current.userPaused = true;
    const answer = await receiver.pause();
    return answer.ok ? { ok: true } : modelRefusal(answer.reason);
  }

  function resumeTake(offerId) {
    const take = current;
    if (take?.offerId !== offerId || take.state !== 'paused') return modelRefusal('model_not_receiving');
    take.userPaused = false;
    take.hostReason = null;
    return drive(take, () => receiver.resume());
  }

  const resume = (offerId) => claim(() => resumeTake(offerId));

  async function cancel(offerId) {
    if (current?.offerId === offerId) {
      const take = current;
      const answer = await receiver.cancel();
      forget(take);
      return answer.ok ? { ok: true } : modelRefusal(answer.reason);
    }
    const take = takes.get(offerId);
    if (!take) return modelRefusal('model_not_receiving');
    return discardTake(take);
  }

  /** After a failure, or staging found after a restart: the same accept again (the receiver adopts its journal). */
  function retry(offerId) {
    return claim(async () => {
      const take = takes.get(offerId);
      if (!take) return modelRefusal('model_not_receiving');
      if (current === take && take.state === 'paused') return resumeTake(offerId);
      if (current) return modelRefusal('model_receiver_busy');
      // The root the take was started in must still be at its index.
      if (roots()[take.rootIndex]?.path !== take.rootPath) return modelRefusal('model_root_invalid');
      const read = await readOffer(offerId);
      if (read.failure) return read.failure;
      if (current) return modelRefusal('model_receiver_busy');
      unlist(take);
      return startTake(offerId, take.rootIndex, take.rootPath, read.manifest, read.summary, { fresh: false });
    });
  }

  /** Staging under a root for an open incoming offer (a restart): listed as `interrupted`, resumed by retry. */
  async function probe(incomingOffers) {
    const rootsNow = roots();
    const staged = new Map();
    for (const [index, root] of rootsNow.entries()) {
      let names;
      try { names = fs.readdirSync(path.join(root.path, INCOMING_DIR)); } catch { continue; }
      for (const name of names) if (!staged.has(name)) staged.set(name, index);
    }
    if (staged.size === 0) return;
    let reads = 0;
    for (const summary of incomingOffers) {
      if (reads >= PROBE_READS || takes.has(summary.offer_id) || disposed) continue;
      reads += 1;
      const read = await readOffer(summary.offer_id);
      if (read.failure) continue;
      const id = transferIdFor({ teamId, senderId: summary.sender_member_id, manifest: read.manifest });
      if (!staged.has(id)) continue;
      const rootIndex = staged.get(id);
      takes.set(summary.offer_id, { offerId: summary.offer_id, senderId: summary.sender_member_id, manifest: read.manifest, rootIndex,
        rootPath: rootsNow[rootIndex].path, state: 'interrupted', reason: 'model_transfer_interrupted', doneBytes: 0,
        totalBytes: summary.total_bytes, hostReason: null, userPaused: false, onFirst: null });
      say('INFO', 'team.model.staging_found', { offer_id: summary.offer_id });
    }
    onChange();
  }

  /**
   * The team is back, or the host shows the transfer live again (the sender came back after this receiver's resume
   * met `team_model_sender_offline`): a transfer the link cut (not one the member paused) runs on. While a call holds
   * the claim this is looked at again once the claim is given back.
   */
  function reconnected() {
    if (claimed) { runOnLater = true; return; }
    const take = current;
    if (disposed || !take || take.state !== 'paused' || take.reason !== 'model_transfer_interrupted' || take.userPaused) return;
    take.hostReason = null;
    void claim(() => drive(take, () => receiver.resume()));
  }

  /** An offer ended on the host: a take that never ran is forgotten, and so is its accept screen. */
  function offerEnded(offerId) {
    reads.delete(offerId);
    const take = takes.get(offerId);
    if (take && take !== current && take.state !== 'interrupted') { takes.delete(offerId); onChange(); }
  }

  /** A received model's provenance file, read bounded and rebuilt field by field. */
  async function provenance(tag) {
    let entry;
    try { entry = (await discovery()).find((row) => row?.tag === tag); } catch { entry = null; }
    if (!entry || typeof entry.mainGguf !== 'string' || !path.isAbsolute(String(entry.dir || ''))) return modelRefusal('model_not_listed');
    let doc;
    try { doc = readJson(path.join(entry.dir, `${entry.mainGguf}${PROVENANCE_SUFFIX}`), { maxBytes: L.provenanceFileBytes }); } catch { doc = null; }
    const text = (value, max, lines = false) => (typeof value === 'string' && value.length <= max
      ? value.replace(lines ? LINE_CONTROL : CONTROL, '') : '');
    if (!doc || typeof doc !== 'object' || doc.schema !== 1 || !Array.isArray(doc.files)) return modelRefusal('team_not_found');
    const words = doc.provenance && typeof doc.provenance === 'object' ? doc.provenance : {};
    return {
      ok: true,
      provenance: {
        display_name: text(doc.display_name, L.maxDisplayNameChars),
        sender_member_id: text(doc.sender?.member_id, 64), sender_name: text(doc.sender?.display_name, L.maxDisplayNameChars),
        received_at: text(doc.received_at, 40), licence: text(words.licence, L.maxLicenceChars, true),
        source_url: words.source_url === null ? null : text(words.source_url, L.maxSourceUrlChars) || null,
        note: text(words.note, L.maxNoteChars, true), checked: words.checked === true,
        files: doc.files.slice(0, L.maxFiles).map((file) => ({ name: text(file?.name, L.maxNameUnits),
          size_bytes: Number.isSafeInteger(file?.size) ? file.size : 0, sha256: SHA.test(file?.sha256) ? file.sha256 : '' })),
      },
    };
  }

  // The 7-day sweep, daily while this module lives. The sweep at start belongs to the roots, not to a team entry:
  // team-models.js runs it once per app run on the first model call (R14-F04), so two sweeps never race at build.
  const sweep = () => { void receiver.sweep(clock()).catch(() => say('WARN', 'team.model.sweep_failed')); };
  let sweepTimer = null;
  function startSweep() {
    sweepTimer = timers.setInterval(sweep, DAY_MS);
    sweepTimer?.unref?.();
  }

  async function dispose() {
    disposed = true;
    if (sweepTimer) { timers.clearInterval(sweepTimer); sweepTimer = null; }
    await receiver.dispose();
    current = null;
  }

  // A take the link or the host stopped shows the host's word when it gave one (the sender stopped, the offer went).
  const reasonOf = (take) => (take.state === 'paused' && take.reason === 'model_transfer_interrupted' && take.hostReason
    ? take.hostReason : take.reason ?? take.hostReason);
  const view = (take) => ({ offer_id: take.offerId, state: take.state, reason: rowReason(reasonOf(take)),
    bytes_done: take.doneBytes, bytes_total: take.totalBytes, root_index: take.rootIndex });

  return Object.freeze({
    offerRead, accept, decline, pause, resume, cancel, retry, probe, reconnected, offerEnded, provenance, startSweep, dispose,
    takeOf: (offerId) => (takes.has(offerId) ? view(takes.get(offerId)) : null),
    sizesOf: (offerId) => takes.get(offerId)?.manifest.files.map((file) => file.size) || null,
    resources: () => ({ ...receiver.resources(), sweepTimers: sweepTimer ? 1 : 0, takes: takes.size, reads: reads.size }),
  });
}

module.exports = { createModelIncoming };
