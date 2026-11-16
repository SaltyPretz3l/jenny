'use strict';

// new-test-file: row 123 slice 6-5 end to end (a new surface): the member's model sender and receiver over the REAL
// team host relay, part routes and member HTTP client, with real files and the real discovery scan.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { PROVENANCE_SUFFIX } = require('../server/team/model-manifest');
const { MODEL_SET, assertRedacted, incomingOffer, lastState, makeModelDir, memberJenny, modelE2eEnv, offer, pair, received,
  recordCommands, sha, states, until } = require('./helpers/team-model-e2e');

// The received model as discovery lists it: exactly once, with its companions and the provenance file beside it.
async function assertPlaced(receiver, source) {
  const entries = await receiver.list();
  assert.equal(entries.length, 1, JSON.stringify(entries));
  const [entry] = entries;
  assert.equal(entry.mainGguf, MODEL_SET[0].name);
  assert.equal(entry.drafterGguf, MODEL_SET[2].name);
  assert.equal(entry.mmproj, true);
  MODEL_SET.forEach((spec, index) => assert.equal(sha(fs.readFileSync(path.join(entry.dir, spec.name))), sha(source.bytes[index])));
  const provenance = JSON.parse(fs.readFileSync(path.join(entry.dir, `${MODEL_SET[0].name}${PROVENANCE_SUFFIX}`), 'utf8'));
  assert.equal(provenance.sender.display_name, 'Mika Member', 'the roster name, not one the renderer gave');
  assert.equal(provenance.provenance.licence, 'Apache-2.0');
  assert.deepEqual(fs.readdirSync(receiver.root).filter((name) => name.startsWith('.')).flatMap((name) => fs.readdirSync(path.join(receiver.root, name))), []);
  return entry;
}

test('a direct offer is accepted, sent, verified, placed and listed once with its companions and provenance', async (t) => {
  const { seats, sender, receiver, source } = await pair(t);
  const requestId = await offer(sender, { memberId: seats.owner.member_id });
  const offerId = await incomingOffer(receiver);
  const read = await receiver.call('modelOfferRead', { offer_id: offerId });
  assert.equal(read.ok, true);
  assert.deepEqual(read.offer.files.map((file) => [file.name, file.size_bytes, file.sha256]),
    MODEL_SET.map((spec, index) => [spec.name, spec.size, sha(source.bytes[index])]));
  assert.equal(read.offer.sender_name, 'Mika Member');
  assert.deepEqual(read.roots.map(({ index, display_path, fits, exists }) => ({ index, display_path, fits, exists })),
    [{ index: 0, display_path: receiver.root, fits: true, exists: false }]);
  assert.deepEqual(await receiver.call('modelAccept', { offer_id: offerId, root_index: 0 }), { ok: true });
  await until(() => received(receiver).length === 1);
  const entry = await assertPlaced(receiver, source);
  assert.deepEqual(received(receiver), [{ kind: 'received', team_id: receiver.member.manager.snapshot() && received(receiver)[0].team_id, tag: entry.tag, root_index: 0 }]);
  await until(() => lastState(sender)?.outgoing.find((row) => row.request_id === requestId)?.state === 'ended');
  const provenance = await receiver.call('modelProvenance', { tag: entry.tag });
  assert.equal(provenance.ok, true);
  assert.equal(provenance.provenance.files.length, 3);
  assert.equal(provenance.provenance.sender_name, 'Mika Member');
  assertRedacted(sender, source);
  assertRedacted(receiver, source);
  // A second copy into the same root is refused before any byte moves.
  const progress = receiver.pushes.filter((push) => push.kind === 'progress');
  assert.ok(progress.every((push) => Object.keys(push).sort().join() === 'bytes_done,bytes_total,direction,kind,offer_id,rate_bps,team_id,transfer_id'));
});

test('a team offer is taken by two members, one re-pulls a corrupt part through cancel and accept, and both land', async (t) => {
  const { env, seats } = await modelE2eEnv(t);
  const sender = await memberJenny(t, env, seats.member, { role: 'member', label: 'sender' });
  const olive = await memberJenny(t, env, seats.owner, { role: 'owner', label: 'olive' });
  const bea = await memberJenny(t, env, seats.bea, { role: 'member', label: 'bea' });
  const source = makeModelDir(sender.root);
  for (const jenny of [sender, olive, bea]) { await jenny.member.connect(); jenny.build(); await jenny.ready; }
  await offer(sender);
  const offerId = await incomingOffer(olive);
  assert.equal(await incomingOffer(bea), offerId);
  // Olive's copy of one part of the drafter is corrupt once: her segment check fails and she pulls it again.
  const oliveSent = recordCommands(olive);
  const beaSent = recordCommands(bea);
  let corrupted = false;
  olive.member.hooks.getModelPart = async (session, client, args) => {
    const answer = await session.getModelPart(client, args);
    if (!corrupted && args.index === 2 && args.n === 1 && answer.bytes) { corrupted = true; answer.bytes[0] ^= 0xff; }
    return answer;
  };
  for (const jenny of [olive, bea]) await jenny.call('modelOfferRead', { offer_id: offerId });
  assert.deepEqual(await olive.call('modelAccept', { offer_id: offerId, root_index: 0 }), { ok: true });
  assert.deepEqual(await bea.call('modelAccept', { offer_id: offerId, root_index: 0 }), { ok: true });
  await until(() => received(olive).length === 1 && received(bea).length === 1, { ms: 60_000 });
  await assertPlaced(olive, source);
  await assertPlaced(bea, source);
  assert.ok(corrupted, 'one of Olive\'s parts was corrupted');
  assert.ok(oliveSent.includes('team.model.cancel'), JSON.stringify(oliveSent));
  assert.ok(oliveSent.filter((operation) => operation === 'team.model.accept').length >= 2, JSON.stringify(oliveSent));
  assert.equal(beaSent.includes('team.model.cancel'), false, 'Bea pulled hers once');
  // One outgoing flow per member: the second transfer waited queued while the first ran.
  assert.ok(states(sender).some((push) => push.outgoing[0]?.transfers.some((row) => row.queued === true)), 'a transfer waited queued');
  for (const jenny of [sender, olive, bea]) assertRedacted(jenny, source);
});

test('the link drops mid-part on each side and the same transfer runs on to the same verified files', async (t) => {
  const { seats, sender, receiver, source } = await pair(t);
  await offer(sender, { memberId: seats.owner.member_id });
  const offerId = await incomingOffer(receiver);
  let gets = 0;
  receiver.member.hooks.getModelPart = (session, client, args) => {
    gets += 1;
    if (gets === 3) { receiver.member.drop(); setTimeout(() => void receiver.member.connect(), 200); }
    return session.getModelPart(client, args);
  };
  let puts = 0;
  sender.member.hooks.putModelPart = (session, client, args) => {
    puts += 1;
    if (puts === 7) { sender.member.drop(); setTimeout(() => void sender.member.connect(), 200); }
    return session.putModelPart(client, args);
  };
  await receiver.call('modelOfferRead', { offer_id: offerId }); // an accept needs its screen (R14-F06)
  assert.deepEqual(await receiver.call('modelAccept', { offer_id: offerId, root_index: 0 }), { ok: true });
  await until(() => received(receiver).length === 1, { ms: 60_000 });
  assert.ok(gets > 3 && puts > 7);
  await assertPlaced(receiver, source);
  assertRedacted(sender, source);
  assertRedacted(receiver, source);
});

test('a receiver restart resumes from its journal; a forced segment mismatch re-pulls through cancel and accept', async (t) => {
  const { seats, sender, receiver, source } = await pair(t);
  await offer(sender, { memberId: seats.owner.member_id });
  const offerId = await incomingOffer(receiver);
  const sent = recordCommands(receiver);
  // The main file is whole and verified; the restart comes during the vision file.
  let gets = 0;
  let stop = null;
  const stopped = new Promise((resolve) => { stop = resolve; });
  receiver.member.hooks.getModelPart = (session, client, args) => {
    gets += 1;
    if (args.index === 1 && stop) { const done = stop; stop = null; done(); }
    return session.getModelPart(client, args);
  };
  await receiver.call('modelOfferRead', { offer_id: offerId }); // an accept needs its screen (R14-F06)
  assert.deepEqual(await receiver.call('modelAccept', { offer_id: offerId, root_index: 0 }), { ok: true });
  await stopped;
  await receiver.models.stopAll();
  receiver.member.hooks.getModelPart = null;
  // A new module over the same disk: the staging is found for the open offer and resumed by retry.
  let corrupted = false;
  receiver.member.hooks.getModelPart = async (session, client, args) => {
    const answer = await session.getModelPart(client, args);
    if (!corrupted && args.index === 2 && args.n === 1 && answer.bytes) { corrupted = true; answer.bytes[0] ^= 0xff; }
    return answer;
  };
  receiver.build();
  const resent = recordCommands(receiver);
  await until(() => lastState(receiver)?.incoming.find((row) => row.offer_id === offerId)?.transfer?.state === 'interrupted');
  assert.deepEqual(await receiver.call('modelReceiveRetry', { offer_id: offerId }), { ok: true });
  await until(() => received(receiver).length === 1, { ms: 60_000 });
  await assertPlaced(receiver, source);
  assert.ok(corrupted, 'one part was corrupted');
  assert.ok(sent.includes('team.model.accept'));
  // The retry accepted again (request reused: the live transfer cancelled first), and the mismatch re-pulled.
  assert.ok(resent.filter((operation) => operation === 'team.model.accept').length >= 2, JSON.stringify(resent));
  assert.ok(resent.includes('team.model.cancel'), JSON.stringify(resent));
  assertRedacted(sender, source);
  assertRedacted(receiver, source);
});

test('a sender restart re-offers with the same request id and the receiver still lands the model', async (t) => {
  const { seats, sender, receiver, source } = await pair(t);
  const requestId = await offer(sender, { memberId: seats.owner.member_id });
  const offerId = await incomingOffer(receiver);
  const file = path.join(sender.profile, 'team');
  const saved = fs.readdirSync(file, { recursive: true }).map(String).find((name) => name.endsWith('model-offers.json'));
  const kept = JSON.parse(fs.readFileSync(path.join(file, saved), 'utf8'));
  assert.deepEqual(kept.offers.map((entry) => [entry.request_id, entry.offer_id]), [[requestId, offerId]]);
  await sender.models.stopAll();
  sender.build();
  await until(() => lastState(sender)?.outgoing.find((row) => row.request_id === requestId)?.offer_id === offerId);
  await receiver.call('modelOfferRead', { offer_id: offerId }); // an accept needs its screen (R14-F06)
  assert.deepEqual(await receiver.call('modelAccept', { offer_id: offerId, root_index: 0 }), { ok: true });
  await until(() => received(receiver).length === 1, { ms: 60_000 });
  await assertPlaced(receiver, source);
  assertRedacted(sender, source);
  assertRedacted(receiver, source);
});

test('a source that changes mid-send stops with model_source_changed; the host gets a plain cancel and the offer goes', async (t) => {
  const { seats, sender, receiver, source } = await pair(t);
  const requestId = await offer(sender, { memberId: seats.owner.member_id });
  const offerId = await incomingOffer(receiver);
  const sent = recordCommands(sender);
  let puts = 0;
  sender.member.hooks.putModelPart = (session, client, args) => {
    puts += 1;
    if (puts === 2) fs.appendFileSync(path.join(source.dir, MODEL_SET[0].name), 'x');
    return session.putModelPart(client, args);
  };
  await receiver.call('modelOfferRead', { offer_id: offerId }); // an accept needs its screen (R14-F06)
  assert.deepEqual(await receiver.call('modelAccept', { offer_id: offerId, root_index: 0 }), { ok: true });
  await until(() => lastState(sender)?.outgoing.find((row) => row.request_id === requestId)?.state === 'failed');
  const row = lastState(sender).outgoing.find((entry) => entry.request_id === requestId);
  assert.equal(row.reason, 'model_source_changed');
  assert.ok(puts <= 3, `the push stopped at the changed part (${puts} puts)`);
  assert.ok(sent.includes('team.model.cancel') && sent.includes('team.model.withdraw'), JSON.stringify(sent));
  assert.equal(received(receiver).length, 0);
  // The failure path is redacted too.
  assertRedacted(sender, source);
  assertRedacted(receiver, source);
});

test('refusals over the real host: read-only, not connected, sharing off at the host, an offer limit, exists', async (t) => {
  const { env, seats, sender, receiver, source } = await pair(t);
  const reader = await memberJenny(t, env, seats.reader, { role: 'read_only', label: 'reader' });
  await reader.member.connect();
  reader.build();
  await reader.ready;
  const reason = (answer) => answer.error?.reason;
  const [model] = (await sender.call('modelSendable')).models;
  assert.equal(reason(await reader.call('modelOffer', { tag: model.tag, files: [], display_name: 'x' })), 'client_unauthorized');
  // Not connected: nothing sent.
  sender.member.drop();
  await until(() => lastState(sender)?.online === false);
  assert.equal(reason(await sender.call('modelOffer', { tag: model.tag, files: [], display_name: 'x' })), 'team_not_connected');
  await sender.member.connect();
  // A file outside the companion set, and a tag the listing does not hold.
  assert.equal(reason(await sender.call('modelOffer', { tag: model.tag, files: ['other.gguf'], display_name: 'x' })), 'model_file_not_offered');
  assert.equal(reason(await sender.call('modelOffer', { tag: 'nope', files: [], display_name: 'x' })), 'model_not_listed');
  // The model lands once; a second offer of it into the same root is refused as exists.
  const first = await offer(sender, { memberId: seats.owner.member_id });
  const offerId = await incomingOffer(receiver);
  await receiver.call('modelOfferRead', { offer_id: offerId }); // an accept needs its screen (R14-F06)
  await receiver.call('modelAccept', { offer_id: offerId, root_index: 0 });
  await until(() => received(receiver).length === 1, { ms: 60_000 });
  await until(() => lastState(sender)?.outgoing.find((row) => row.request_id === first)?.state === 'ended');
  await offer(sender, { memberId: seats.owner.member_id });
  const again = await incomingOffer(receiver);
  const read = await receiver.call('modelOfferRead', { offer_id: again });
  assert.equal(read.roots[0].exists, true);
  assert.equal(reason(await receiver.call('modelAccept', { offer_id: again, root_index: 0 })), 'model_exists');
  assert.equal(reason(await receiver.call('modelAccept', { offer_id: again, root_index: 3 })), 'model_root_invalid');
  // Sharing off at the host: the next list (a reconnect) says so, and an offer or accept is refused here, sending nothing.
  env.models.setFlowingLimit(0);
  sender.member.drop();
  await sender.member.connect();
  await until(() => lastState(sender)?.sharing === 'off');
  assert.equal(lastState(sender).sharing_reason, 'team_model_sharing_off');
  assert.equal(reason(await sender.call('modelOffer', { tag: model.tag, files: [], display_name: 'x' })), 'team_model_sharing_off');
  assert.equal(source.bytes.length, 3);
  for (const jenny of [sender, receiver, reader]) assertRedacted(jenny, source);
});

// The injected clock runs 20 times faster than the wall, so a part every few milliseconds is many clock steps apart.
function fastClock() {
  const start = performance.now();
  return () => 1_800_000_000_000 + Math.round((performance.now() - start) * 20);
}

test('progress at most 4 a second per transfer each way on an advancing clock; after drop, Force local and stop nothing is left', async (t) => {
  let held = false;
  const { env, seats, sender, receiver, source } = await pair(t, { options: { sender: { clock: fastClock() },
    receiver: { clock: fastClock(), isHeld: () => held } } });
  const sockets = receiver.member.proxy.sockets();
  await offer(sender, { memberId: seats.owner.member_id });
  const offerId = await incomingOffer(receiver);
  await receiver.call('modelOfferRead', { offer_id: offerId });
  receiver.member.hooks.getModelPart = async (session, client, args) => {
    await new Promise((resolve) => setTimeout(resolve, 15));
    return session.getModelPart(client, args);
  };
  assert.deepEqual(await receiver.call('modelAccept', { offer_id: offerId, root_index: 0 }), { ok: true });
  await until(() => received(receiver).length === 1);
  await new Promise((resolve) => setTimeout(resolve, 100));
  for (const [jenny, direction] of [[receiver, 'receive'], [sender, 'send']]) {
    const progress = jenny.pushes.filter((push) => push.kind === 'progress' && push.direction === direction);
    const perTransfer = Object.groupBy(progress, (push) => push.transfer_id);
    assert.ok(Object.keys(perTransfer).length >= 1, `${direction}: progress was pushed`);
    for (const pushes of Object.values(perTransfer)) {
      assert.ok(pushes.length >= 2, `${direction}: more than the last byte (${pushes.length})`);
      const finals = pushes.filter((push) => push.bytes_done === push.bytes_total);
      assert.equal(finals.length, 1, `${direction}: the final byte once`);
      assert.equal(pushes.at(-1), finals[0]);
      for (let index = 1; index < pushes.length - 1; index += 1) {
        assert.ok(pushes[index].at - pushes[index - 1].at >= 250, `${direction}: ${pushes[index].at - pushes[index - 1].at} ms apart`);
      }
    }
  }
  assert.equal(received(receiver).length, 1, 'received once per landed model');
  assert.equal(receiver.models.resources().listeners, 1);
  assertRedacted(sender, source);
  assertRedacted(receiver, source);
  // Force local: every call refused while held; the release builds again on the next call.
  held = true;
  assert.equal((await receiver.call('modelState')).error.reason, 'team_force_local');
  held = false;
  receiver.models.drop(env.teamId);
  await until(() => receiver.models.resources().teams === 0);
  // A drop mid-pull keeps the staging; the entry leaves no timer, wait, worker or listener.
  await offer(sender, { memberId: seats.owner.member_id });
  await receiver.call('modelState');
  const second = await incomingOffer(receiver);
  // The first copy goes, so the second offer is not refused as exists.
  fs.rmSync((await receiver.list())[0].dir, { recursive: true, force: true });
  receiver.member.hooks.getModelPart = async (session, client, args) => {
    if (args.index === 0 && args.n === 4) receiver.models.drop(env.teamId);
    return session.getModelPart(client, args);
  };
  await receiver.call('modelOfferRead', { offer_id: second }); // an accept needs its screen (R14-F06)
  await receiver.call('modelAccept', { offer_id: second, root_index: 0 });
  await until(() => receiver.models.resources().teams === 0);
  await until(() => fs.readdirSync(path.join(receiver.root, '.jenny-incoming')).length === 1);
  await receiver.models.stopAll();
  await sender.models.stopAll();
  for (const jenny of [receiver, sender]) {
    const left = jenny.models.resources();
    assert.deepEqual({ teams: left.teams, stopping: left.stopping, timers: left.timers, waits: left.waits, listeners: left.listeners,
      workers: left.workers, handles: left.handles, pushes: left.pushes, reads: left.reads },
    { teams: 0, stopping: 0, timers: 0, waits: 0, listeners: 0, workers: 0, handles: 0, pushes: 0, reads: 0 });
    assert.equal(jenny.member.listeners(), 0, 'no listener left on the member feed');
  }
  // The part calls' connections went with the stop: the proxy carries what it did before the transfers.
  await until(() => receiver.member.proxy.sockets() <= sockets, { ms: 5000 });
});
