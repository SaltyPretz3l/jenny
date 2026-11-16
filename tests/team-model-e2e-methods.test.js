'use strict';

// new-test-file: row 123 slice 6-5 end to end, second file (the first is at its share of the line cap): every model
// method with a good payload over the REAL host relay, part routes and member HTTP client, accept and resume races,
// a re-pull on a team offer and a cut in the middle of a part's body.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { assertRedacted, incomingOffer, lastState, memberJenny, makeModelDir, modelE2eEnv, offer, pair, received,
  recordCommands, until } = require('./helpers/team-model-e2e');

const pause = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
const reasonOf = (answer) => answer?.error?.reason ?? null;

// Every part GET the receiver sends, slowed by `delayMs` so a test can act while the download runs.
function slowGets(receiver, delayMs) {
  const gets = [];
  receiver.member.hooks.getModelPart = async (session, client, args) => {
    gets.push([args.index, args.n]);
    await pause(delayMs);
    return session.getModelPart(client, args);
  };
  return gets;
}

const incomingRow = (jenny, offerId) => lastState(jenny)?.incoming.find((row) => row.offer_id === offerId) || null;

test('two accepts in one tick: one starts, one is refused, and a cancel then really stops the download', async (t) => {
  const { seats, sender, receiver, source } = await pair(t);
  await offer(sender, { memberId: seats.owner.member_id });
  const offerId = await incomingOffer(receiver);
  await receiver.call('modelOfferRead', { offer_id: offerId });
  const gets = slowGets(receiver, 40);
  const answers = await Promise.all([receiver.call('modelAccept', { offer_id: offerId, root_index: 0 }),
    receiver.call('modelAccept', { offer_id: offerId, root_index: 0 })]);
  assert.deepEqual(answers.filter((answer) => answer.ok === true).length, 1, JSON.stringify(answers));
  assert.equal(reasonOf(answers.find((answer) => answer.ok !== true)), 'model_receiver_busy');
  await until(() => gets.length >= 2);
  assert.deepEqual(await receiver.call('modelReceiveCancel', { offer_id: offerId }), { ok: true });
  const after = gets.length;
  await pause(400);
  assert.ok(gets.length <= after + 1, `no part GET after the cancel (${after} then ${gets.length})`);
  assert.equal(received(receiver).length, 0);
  assert.equal(incomingRow(receiver, offerId)?.transfer ?? null, null, 'the cancelled take is gone');
  assertRedacted(sender, source);
  assertRedacted(receiver, source);
});

test('two resumes in one tick: one runs, one is refused, both answer, and the model lands once', async (t) => {
  const { seats, sender, receiver, source } = await pair(t);
  await offer(sender, { memberId: seats.owner.member_id });
  const offerId = await incomingOffer(receiver);
  await receiver.call('modelOfferRead', { offer_id: offerId });
  const gets = slowGets(receiver, 30);
  assert.deepEqual(await receiver.call('modelAccept', { offer_id: offerId, root_index: 0 }), { ok: true });
  await until(() => gets.length >= 2);
  assert.deepEqual(await receiver.call('modelReceivePause', { offer_id: offerId }), { ok: true });
  await until(() => incomingRow(receiver, offerId)?.transfer?.state === 'paused');
  const answered = Promise.all([receiver.call('modelReceiveResume', { offer_id: offerId }),
    receiver.call('modelReceiveResume', { offer_id: offerId })]);
  const both = await Promise.race([answered, pause(10_000).then(() => null)]);
  assert.notEqual(both, null, 'both resume calls answered');
  assert.equal(both.filter((answer) => answer.ok === true).length, 1, JSON.stringify(both));
  assert.ok(['model_receiver_busy', 'model_not_receiving'].includes(reasonOf(both.find((answer) => answer.ok !== true))));
  await until(() => received(receiver).length === 1, { ms: 60_000 });
  await pause(100);
  assert.equal(received(receiver).length, 1);
  assertRedacted(sender, source);
  assertRedacted(receiver, source);
});

const outgoingRow = (jenny, requestId) => lastState(jenny)?.outgoing.find((row) => row.request_id === requestId) || null;
const stagingOf = (jenny) => {
  const dir = path.join(jenny.root, '.jenny-incoming');
  return fs.existsSync(dir) ? fs.readdirSync(dir) : [];
};

test('the sender pauses, resumes and stops a transfer; modelReceivers lists who may receive', async (t) => {
  const { seats, sender, receiver, source } = await pair(t);
  const members = (await sender.call('modelReceivers')).members;
  assert.deepEqual(members.map((member) => [member.display_name, member.role, member.can_receive]).sort(),
    [['Bea Member', 'member', true], ['Olive Owner', 'owner', true], ['Rui Reader', 'read_only', false]]);
  const requestId = await offer(sender, { memberId: seats.owner.member_id });
  const offerId = await incomingOffer(receiver);
  await receiver.call('modelOfferRead', { offer_id: offerId });
  const gets = slowGets(receiver, 150);
  assert.deepEqual(await receiver.call('modelAccept', { offer_id: offerId, root_index: 0 }), { ok: true });
  await until(() => outgoingRow(sender, requestId)?.transfers.length === 1 && gets.length >= 2);
  const transferId = outgoingRow(sender, requestId).transfers[0].transfer_id;
  assert.deepEqual(await sender.call('modelSendPause', { transfer_id: transferId }), { ok: true });
  await until(() => outgoingRow(sender, requestId)?.transfers[0]?.state === 'paused');
  assert.deepEqual(await sender.call('modelSendResume', { transfer_id: transferId }), { ok: true });
  await until(() => outgoingRow(sender, requestId)?.transfers[0]?.state === 'flowing');
  // The sender's stop cancels the transfer and reopens the direct offer; the receiver keeps its staging, paused with the
  // host's word, so a retry can take the offer again from where it was.
  assert.deepEqual(await sender.call('modelSendStop', { transfer_id: transferId }), { ok: true });
  await until(() => outgoingRow(sender, requestId)?.transfers[0]?.state === 'cancelled');
  await until(() => incomingRow(receiver, offerId)?.transfer?.reason === 'cancelled_by_sender');
  assert.equal(incomingRow(receiver, offerId).transfer.state, 'paused');
  assert.equal(incomingRow(receiver, offerId).state, 'open');
  await pause(200);
  assert.equal(received(receiver).length, 0);
  assertRedacted(sender, source);
  assertRedacted(receiver, source);
});

test('a withdrawn offer and a declined offer each end on both sides; the outgoing limit can be set to 1 and back to 0', async (t) => {
  const { seats, sender, receiver, source } = await pair(t);
  const first = await offer(sender, { memberId: seats.owner.member_id });
  const firstOffer = await incomingOffer(receiver);
  assert.deepEqual(await sender.call('modelWithdraw', { request_id: first }), { ok: true });
  await until(() => outgoingRow(sender, first)?.state === 'ended' && incomingRow(receiver, firstOffer)?.state !== 'open');
  assert.equal(outgoingRow(sender, first).reason, 'withdrawn');
  const second = await offer(sender, { memberId: seats.owner.member_id });
  const secondOffer = await incomingOffer(receiver);
  assert.deepEqual(await receiver.call('modelDecline', { offer_id: secondOffer }), { ok: true });
  await until(() => outgoingRow(sender, second)?.state === 'ended');
  assert.equal(outgoingRow(sender, second).reason, 'declined');
  // The limit: 1 MB/s is kept in the member's own file and the state; a transfer under it takes at least its time.
  assert.deepEqual(await sender.call('modelSetRate', { mb_per_second: 1 }), { ok: true, mb_per_second: 1 });
  await until(() => lastState(sender)?.rate_mb_per_second === 1);
  const third = await offer(sender, { memberId: seats.owner.member_id });
  const thirdOffer = await incomingOffer(receiver);
  await receiver.call('modelOfferRead', { offer_id: thirdOffer });
  const started = Date.now();
  assert.deepEqual(await receiver.call('modelAccept', { offer_id: thirdOffer, root_index: 0 }), { ok: true });
  await until(() => received(receiver).length === 1, { ms: 60_000 });
  const total = outgoingRow(sender, third).total_bytes;
  assert.ok(Date.now() - started >= (total / 1_000_000) * 1000 * 0.8, `${Date.now() - started} ms for ${total} bytes at 1 MB/s`);
  assert.deepEqual(await sender.call('modelSetRate', { mb_per_second: 0 }), { ok: true, mb_per_second: 0 });
  await until(() => lastState(sender)?.rate_mb_per_second === 0);
  const files = fs.readdirSync(sender.profile, { recursive: true }).map(String);
  assert.equal(files.some((name) => name.endsWith('model-sending.json')), false, 'no limit file once it is 0');
  assertRedacted(sender, source);
  assertRedacted(receiver, source);
});

test('no space is refused before any byte; the sender offline at accept leaves a failed row and no staging', async (t) => {
  const { env, seats } = await modelE2eEnv(t);
  const sender = await memberJenny(t, env, seats.member, { role: 'member', label: 'sender' });
  const full = await memberJenny(t, env, seats.owner, { role: 'owner', label: 'full' });
  const roomy = await memberJenny(t, env, seats.bea, { role: 'member', label: 'roomy' });
  const source = makeModelDir(sender.root);
  for (const jenny of [sender, full, roomy]) await jenny.member.connect();
  sender.build();
  full.build({ receiveLimits: { freeSpaceMarginBytes: 2 ** 52 } });
  roomy.build();
  await Promise.all([sender.ready, full.ready, roomy.ready]);
  await offer(sender);
  const offerId = await incomingOffer(full);
  assert.equal(await incomingOffer(roomy), offerId);
  await full.call('modelOfferRead', { offer_id: offerId });
  assert.equal(reasonOf(await full.call('modelAccept', { offer_id: offerId, root_index: 0 })), 'model_no_space');
  assert.deepEqual(stagingOf(full), []);
  // The sender's link goes; the host marks it gone at once (its member stream closed) and refuses the accept.
  await roomy.call('modelOfferRead', { offer_id: offerId });
  sender.member.drop();
  await pause(300);
  const answer = await roomy.call('modelAccept', { offer_id: offerId, root_index: 0 });
  assert.equal(reasonOf(answer), 'team_model_sender_offline', JSON.stringify(answer));
  await until(() => incomingRow(roomy, offerId)?.transfer?.state === 'failed');
  assert.equal(incomingRow(roomy, offerId).transfer.reason, 'team_model_sender_offline');
  assert.deepEqual(stagingOf(roomy), [], 'the fresh staging went');
  for (const jenny of [sender, full, roomy]) assertRedacted(jenny, source);
});

test('a part corrupt on every pull ends in model_hash_mismatch: a failed row, nothing placed', async (t) => {
  const { seats, sender, receiver, source } = await pair(t);
  await offer(sender, { memberId: seats.owner.member_id });
  const offerId = await incomingOffer(receiver);
  await receiver.call('modelOfferRead', { offer_id: offerId });
  receiver.member.hooks.getModelPart = async (session, client, args) => {
    const answer = await session.getModelPart(client, args);
    if (args.index === 1 && args.n === 1 && answer.bytes) answer.bytes[0] ^= 0xff;
    return answer;
  };
  assert.deepEqual(await receiver.call('modelAccept', { offer_id: offerId, root_index: 0 }), { ok: true });
  await until(() => incomingRow(receiver, offerId)?.transfer?.state === 'failed', { ms: 60_000 });
  assert.equal(incomingRow(receiver, offerId).transfer.reason, 'model_hash_mismatch');
  assert.equal(received(receiver).length, 0);
  assert.deepEqual(await receiver.list(), []);
  assertRedacted(sender, source);
  assertRedacted(receiver, source);
});

// The landed receiver (6-4) keeps only verified segments across a restart (model-receive.js run(): trimToVerified):
// with the real 1 GiB segment a restart pulls again at most the segment it was in; these test files are one segment
// each, so a restart pulls again the file it was in, never a file already whole.
test('a cut in the middle of a part body asks for that part again only; after a restart no whole file is pulled again', async (t) => {
  const { seats, sender, receiver, source } = await pair(t);
  await offer(sender, { memberId: seats.owner.member_id });
  const offerId = await incomingOffer(receiver);
  await receiver.call('modelOfferRead', { offer_id: offerId });
  const calls = [];
  let phase = 'cut';
  let restartNow = null;
  const restart = new Promise((resolve) => { restartNow = resolve; });
  receiver.member.hooks.getModelPart = async (session, client, args) => {
    calls.push(`${args.index}:${args.n}`);
    // The answer to this GET is cut halfway through its 16 KiB body.
    if (phase === 'cut' && args.index === 0 && args.n === 5) { phase = 'restart'; receiver.member.proxy.cutAfter(8 * 1024); }
    // The main file is whole and verified: the receiver stops during the vision file.
    if (phase === 'restart' && args.index === 1 && args.n === 1) { phase = 'done'; restartNow(); }
    return session.getModelPart(client, args);
  };
  assert.deepEqual(await receiver.call('modelAccept', { offer_id: offerId, root_index: 0 }), { ok: true });
  await restart;
  await receiver.models.stopAll();
  const cutAt = calls.indexOf('0:5');
  assert.ok(calls.filter((part) => part === '0:5').length >= 2, `the cut part was asked again: ${calls.join(',')}`);
  assert.deepEqual(calls.slice(cutAt).filter((part) => ['0:0', '0:1', '0:2', '0:3', '0:4'].includes(part)), [],
    `no earlier part after the cut: ${calls.join(',')}`);
  const after = [];
  receiver.member.hooks.getModelPart = async (session, client, args) => {
    after.push(`${args.index}:${args.n}`);
    return session.getModelPart(client, args);
  };
  receiver.build();
  await until(() => incomingRow(receiver, offerId)?.transfer?.state === 'interrupted');
  assert.deepEqual(await receiver.call('modelReceiveRetry', { offer_id: offerId }), { ok: true });
  await until(() => received(receiver).length === 1, { ms: 60_000 });
  assert.deepEqual(after.filter((part) => part.startsWith('0:')), [], `the whole main file was not pulled again: ${after.join(',')}`);
  assert.equal(after[0], '1:0', 'the vision file is pulled again from its segment start');
  assertRedacted(sender, source);
  assertRedacted(receiver, source);
});

test('the receiver reconnects while the sender is still away: the take never fails and runs on once the sender is back', async (t) => {
  const { seats, sender, receiver, source } = await pair(t);
  await offer(sender, { memberId: seats.owner.member_id });
  const offerId = await incomingOffer(receiver);
  const sent = recordCommands(receiver);
  let gets = 0;
  let cut = null;
  receiver.member.hooks.getModelPart = async (session, client, args) => {
    gets += 1;
    const answer = await session.getModelPart(client, args);
    if (gets === 3) {
      // Both links go once this part is in: the receiver's next part call meets no connection.
      sender.member.drop();
      receiver.member.drop();
      cut = (async () => {
        await pause(100);
        await receiver.member.connect();
        // The receiver's own resume meets the host's sender_offline before the sender comes back.
        await until(() => receiver.logs.some((entry) => entry.event === 'team.model.receive_transport_failed'
          && entry.fields.call === 'resume' && entry.fields.code === 'team_model_sender_offline'));
        await sender.member.connect();
      })();
    }
    return answer;
  };
  await receiver.call('modelOfferRead', { offer_id: offerId }); // an accept needs its screen (R14-F06)
  assert.deepEqual(await receiver.call('modelAccept', { offer_id: offerId, root_index: 0 }), { ok: true });
  await until(() => cut !== null);
  await cut;
  await until(() => received(receiver).length === 1, { ms: 30_000 });
  // A cancel here is only the transport's re-pull (an accept follows it), never the end of the take.
  sent.forEach((operation, index) => {
    if (operation === 'team.model.cancel') assert.equal(sent[index + 1], 'team.model.accept', JSON.stringify(sent));
  });
  assert.ok(sent.includes('team.model.resume'), JSON.stringify(sent));
  const failed = receiver.pushes.filter((push) => push.kind === 'state')
    .flatMap((push) => push.incoming).filter((row) => row.transfer?.state === 'failed');
  assert.deepEqual(failed, [], 'no failed row was ever pushed');
  assertRedacted(receiver, source);
});
