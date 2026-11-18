'use strict';

// new-test-file: row 180 agent steering is a new surface (services/backend/user-steer-mid-turn.js and its IPC
// payload guard); the settle-path releases live in chat-stream-managed-terminal-settlement.test.js and the
// capability, client and descriptor cases in their own files.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { ElectronSessionStore } = require('../services/backend/electron-session-store');
const { SidecarClient } = require('../services/backend/sidecar-client');
const { attachMidTurnMail } = require('../services/backend/session-mail-mid-turn');
const { handleNotification } = require('../services/backend/chat-stream-managed-runtime-notifications');
const { buildPreparedContextHistory } = require('../services/backend/chat-stream-reasoning');
const { buildFeatureFlags } = require('../services/feature-flags');
const { getBridgeChannel } = require('../services/ipc-contract');
const chatIpc = require('../services/main/ipc-registration/chat-ipc');
const {
  acceptUserSteerConsumedNotification, attachUserSteer, offerUserSteer, releaseUserSteers, withdrawUserSteer,
} = require('../services/backend/user-steer-mid-turn');

const ACK = {
  schema_version: 1, producer_tools: [], context_kinds: ['session_message'], session_messages: true,
  mid_turn_mail: true, mid_turn_steer: true,
};

function pngFile(root, name = 'pic.png') {
  const file = path.join(root, name);
  fs.writeFileSync(file, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  return file;
}

const imageEntry = (file, n = 1) => ({
  id: `img_${n}`, kind: 'image', displayName: `pic${n}.png`, mimeType: 'image/png', sizeBytes: 4, width: 1, height: 1,
  assetPath: file, sourceKind: 'file', extra: 'dropped',
});
const textEntry = (name, text) => ({ id: `att_${name}`, kind: 'text', displayName: name, promptName: name, text, sizeBytes: text.length });

async function setup(t, { capabilities = ACK, flags = {}, hostMode } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-user-steer-'));
  const store = new ElectronSessionStore(path.join(root, 'sessions.json'), { logger() {} });
  t.after(() => {
    store.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const session = store.createSession({ title: 'Working' });
  const client = new SidecarClient();
  client.process = {};
  client.request = async () => ({ runtime_inference_admission_version: 1, chat_workspace_version: 1, chat_workspace_capabilities: capabilities });
  await client.initialize();
  client.arrived = [];
  client.withdrawn = [];
  client.sendResult = true;
  client.notifyUserSteerArrived = (params) => { client.arrived.push(params); return client.sendResult; };
  client.notifyUserSteerWithdrawn = (params) => { client.withdrawn.push(params); return client.sendResult; };
  store.getActiveTurn = (id) => (id === session.id ? { request_id: 'stream_1', stream_id: 'stream_1', turn_id: 'turn_1' } : null);
  const logs = [];
  const emitted = [];
  const service = {
    sessionStore: store,
    sidecarClient: client,
    featureFlags: flags,
    hostMode,
    activeStreams: new Map([['stream_1', {}]]),
    attachmentAssetStore: { resolveManagedAssetRealPath: (p) => (fs.existsSync(p) ? p : null), isManagedAssetPath: () => true },
    _emitServiceLog: (level, event, details) => logs.push({ level, event, details }),
    emit: (name, payload) => emitted.push({ name, payload }),
  };
  const segmentCalls = [];
  const ctx = {
    service, resolvedSessionId: session.id, streamId: 'stream_1', turnId: 'turn_1', model: 'm',
    adapter: { appendMessage: (message, options) => store.appendMessage(session.id, message, options) },
    persistCurrentTextSegment: (options) => {
      segmentCalls.push(options);
      store.appendMessage(session.id, { id: 'assistant_stream_1_seg1', role: 'assistant', content: 'closing the segment', turn_id: 'turn_1' }, { updatePreview: false });
    },
  };
  attachMidTurnMail(ctx);
  attachUserSteer(ctx);
  const seed = () => {
    store.appendMessage(session.id, { id: 'u1', role: 'user', content: 'go', turn_id: 'turn_1' });
    store.appendMessage(session.id, { id: 'tu1', role: 'assistant', kind: 'tool_use', content: 'run', turn_id: 'turn_1' });
    store.appendMessage(session.id, { id: 'tr1', role: 'tool', kind: 'tool_result', content: 'ok', turn_id: 'turn_1' });
  };
  const rows = () => store.getSession(session.id).messages;
  return { root, store, id: session.id, service, client, ctx, logs, emitted, segmentCalls, seed, rows };
}

const offer = (env, over = {}) => offerUserSteer(env.service, { sessionId: env.id, itemId: 'outbox_a1', prompt: 'also check the logs', attachments: [], ...over });

test('an offer is refused with the kill switch, an unnegotiated capability and a hosted service', async (t) => {
  const off = await setup(t, { flags: { mid_turn_steer: false } });
  assert.deepEqual(offer(off), { ok: false, reason: 'disabled' });
  assert.equal(off.client.arrived.length, 0);

  const { mid_turn_steer: _omitted, ...withoutSteer } = ACK;
  const old = await setup(t, { capabilities: withoutSteer });
  assert.deepEqual(offer(old), { ok: false, reason: 'unsupported' });

  const hosted = await setup(t, { hostMode: 'server' });
  assert.deepEqual(offer(hosted), { ok: false, reason: 'unsupported' });
  assert.equal(old.client.arrived.length + hosted.client.arrived.length, 0);
});

test('an offer without a live managed stream is refused', async (t) => {
  const env = await setup(t);
  assert.equal(offer(env, { sessionId: 'sess_other' }).reason, 'no_live_stream');
  env.service.activeStreams.clear();
  assert.equal(offer(env).reason, 'no_live_stream');
  env.service.activeStreams.set('stream_1', {});
  env.store.getActiveTurn = () => null;
  assert.equal(offer(env).reason, 'no_live_stream');
  assert.equal(offerUserSteer(null, undefined).ok, false);
  assert.equal(env.client.arrived.length, 0);
});

test('a bad item id or payload is invalid and sends nothing', async (t) => {
  const env = await setup(t);
  const bad = [
    { itemId: '' }, { itemId: 'a1' }, { itemId: 'outbox_' }, { itemId: 'outbox_UPPER' }, { itemId: `outbox_${'a'.repeat(81)}` },
    { itemId: 'outbox_a b' }, { itemId: 7 }, { prompt: 7 }, { prompt: '   ' }, { attachments: 'x' }, { attachments: [null] },
    { attachments: [{ kind: 'audio', displayName: 'a.wav', assetPath: 'x' }] },
    { prompt: '', attachments: [imageEntry(path.join(env.root, 'missing.png'))] },
    { attachments: [imageEntry(path.join(env.root, 'missing.png'))] },
  ];
  for (const over of bad) assert.deepEqual(offer(env, over), { ok: false, reason: 'invalid' }, JSON.stringify(over));
  assert.deepEqual(offerUserSteer(env.service, { sessionId: '', itemId: 'outbox_a1', prompt: 'x', attachments: [] }), { ok: false, reason: 'invalid' });
  assert.equal(offer(env).ok, true);
  assert.deepEqual(offer(env), { ok: false, reason: 'invalid' }, 'a repeated item id is not parked twice');
  assert.equal(env.client.arrived.length, 1);
});

test('the per-turn bounds mirror the sidecar: 8 items, 32 KiB of content, 4 images per item', async (t) => {
  const env = await setup(t);
  for (let n = 1; n <= 8; n += 1) assert.equal(offer(env, { itemId: `outbox_n${n}` }).ok, true, `item ${n}`);
  assert.deepEqual(offer(env, { itemId: 'outbox_n9' }), { ok: false, reason: 'over_budget' });

  const big = await setup(t);
  assert.equal(offer(big, { itemId: 'outbox_b1', prompt: 'a'.repeat(20 * 1024) }).ok, true);
  assert.deepEqual(offer(big, { itemId: 'outbox_b2', prompt: 'b'.repeat(20 * 1024) }), { ok: false, reason: 'over_budget' });
  assert.deepEqual(offer(big, { itemId: 'outbox_b3', prompt: 'c'.repeat(33 * 1024) }), { ok: false, reason: 'over_budget' });
  assert.equal(offer(big, { itemId: 'outbox_b4', prompt: 'small' }).ok, true, 'a refused offer is not charged');

  const images = await setup(t);
  const file = pngFile(images.root);
  const five = [1, 2, 3, 4, 5].map((n) => imageEntry(file, n));
  assert.deepEqual(offer(images, { attachments: five }), { ok: false, reason: 'over_budget' });
  assert.equal(offer(images, { attachments: five.slice(0, 4) }).ok, true);
  assert.equal(images.client.arrived.length, 1);
  assert.equal(offer(images, { itemId: 'outbox_i2', attachments: five.slice(0, 4) }).ok, true);
  assert.deepEqual(offer(images, { itemId: 'outbox_i3', attachments: five.slice(0, 1) }), { ok: false, reason: 'over_budget' },
    'at most 8 images per turn: decoded images ride every later generation');
  assert.equal(offer(images, { itemId: 'outbox_i4', prompt: 'text still fits' }).ok, true);
});

test('an accepted offer sends the live request id, inlines text files and passes images through', async (t) => {
  const env = await setup(t);
  const file = pngFile(env.root);
  const result = offer(env, {
    prompt: 'use this too',
    attachments: [textEntry('notes.txt', 'line one'), imageEntry(file)],
  });
  assert.deepEqual(result, { ok: true });
  assert.equal(env.client.arrived.length, 1);
  const [params] = env.client.arrived;
  assert.deepEqual(Object.keys(params).sort(), ['items', 'requestId', 'sessionId']);
  assert.equal(params.sessionId, env.id);
  assert.equal(params.requestId, 'stream_1');
  assert.equal(params.items.length, 1);
  const [item] = params.items;
  assert.deepEqual(Object.keys(item).sort(), ['content', 'images', 'item_id']);
  assert.equal(item.item_id, 'outbox_a1');
  assert.equal(item.content, 'use this too\n\nAttached files:\n--- file: notes.txt ---\nline one\n--- end file ---');
  assert.deepEqual(item.images, [{
    id: 'img_1', kind: 'image', displayName: 'pic1.png', mimeType: 'image/png', sizeBytes: 4, width: 1, height: 1,
    assetPath: file, sourceKind: 'file',
  }]);
  assert.ok(env.ctx.userSteer.reserved.has('outbox_a1'));
  assert.doesNotMatch(JSON.stringify(env.logs), /use this too|notes\.txt|line one/, 'logs carry ids and counts, never content');
});

test('an image-only offer reaches the model with a fixed line beside its images; a fully empty one is invalid', async (t) => {
  const env = await setup(t);
  const file = pngFile(env.root);
  assert.deepEqual(offer(env, { prompt: '', attachments: [imageEntry(file)] }), { ok: true });
  const [item] = env.client.arrived[0].items;
  assert.equal(item.content, '(The person sent an image.)');
  assert.equal(item.images.length, 1);
  assert.equal(env.ctx.userSteer.reserved.get('outbox_a1').prompt, '', 'the persisted row keeps what the person typed');
  assert.deepEqual(offer(env, { itemId: 'outbox_a2', prompt: '  ', attachments: [] }), { ok: false, reason: 'invalid' });
});

test('a failed hand-off to the sidecar releases the reservation and refuses transport_unavailable', async (t) => {
  const env = await setup(t);
  env.client.sendResult = false;
  assert.deepEqual(offer(env), { ok: false, reason: 'transport_unavailable' });
  assert.equal(env.ctx.userSteer.reserved.size, 0);
  env.client.sendResult = true;
  assert.equal(offer(env).ok, true, 'a failed send charges nothing and frees the id');
});

test('withdraw before consumption tells the sidecar; after consumption it reports consumed', async (t) => {
  const env = await setup(t);
  offer(env);
  offer(env, { itemId: 'outbox_a2', prompt: 'second' });
  assert.deepEqual(withdrawUserSteer(env.service, { sessionId: env.id, itemId: 'outbox_a1' }), { ok: true });
  assert.deepEqual(env.client.withdrawn, [{ sessionId: env.id, requestId: 'stream_1', itemIds: ['outbox_a1'] }]);

  acceptUserSteerConsumedNotification(env.ctx, { item_ids: ['outbox_a2'], iteration: 2 });
  assert.deepEqual(withdrawUserSteer(env.service, { sessionId: env.id, itemId: 'outbox_a2' }), { ok: false, reason: 'consumed' });
  assert.equal(env.client.withdrawn.length, 1);

  assert.deepEqual(withdrawUserSteer(env.service, { sessionId: env.id, itemId: 'outbox_zz' }), { ok: false, reason: 'unknown' });
  assert.deepEqual(withdrawUserSteer(env.service, { sessionId: env.id, itemId: 'bad id' }), { ok: false, reason: 'unknown' });
  assert.deepEqual(withdrawUserSteer(env.service, { sessionId: 'sess_other', itemId: 'outbox_a1' }), { ok: false, reason: 'unknown' });
  env.client.sendResult = false;
  offer(env, { itemId: 'outbox_a3' }); // refused (transport), never reserved
  assert.deepEqual(withdrawUserSteer(env.service, { sessionId: env.id, itemId: 'outbox_a3' }), { ok: false, reason: 'unknown' });
});

test('a withdrawn item that the drain still won is persisted and shown, and is never released as unconsumed', async (t) => {
  const env = await setup(t);
  offer(env);
  withdrawUserSteer(env.service, { sessionId: env.id, itemId: 'outbox_a1' });
  assert.equal(acceptUserSteerConsumedNotification(env.ctx, { item_ids: ['outbox_a1'] }), 1, 'the model took it, so the row must exist');
  assert.ok(env.rows().some((row) => row.id === 'steer_outbox_a1'));

  const other = await setup(t);
  offer(other);
  withdrawUserSteer(other.service, { sessionId: other.id, itemId: 'outbox_a1' });
  assert.deepEqual(releaseUserSteers(other.ctx, 'terminal'), []);
  assert.equal(other.emitted.length, 0, 'the renderer already removed the card');
});

test('the consumed ack closes the segment, appends the steer row after the last tool_result and emits it', async (t) => {
  const env = await setup(t);
  env.seed();
  const file = pngFile(env.root);
  offer(env, { prompt: 'use this too', attachments: [textEntry('notes.txt', 'line one'), imageEntry(file)] });

  assert.equal(acceptUserSteerConsumedNotification(env.ctx, { item_ids: ['outbox_a1'], iteration: 2 }), 1);

  assert.deepEqual(env.segmentCalls, [{ allowReasoningOnly: true, atToolBoundary: true }]);
  assert.deepEqual(env.rows().map((row) => row.id), ['u1', 'tu1', 'tr1', 'assistant_stream_1_seg1', 'steer_outbox_a1']);
  const row = env.rows()[4];
  assert.deepEqual([row.role, row.kind, row.turn_id, row.outbox_item_id], ['user', 'steer', 'turn_1', 'outbox_a1']);
  assert.equal(row.content, 'use this too', 'the person\'s words, without inlined file blocks');
  assert.deepEqual(row.attachments.map((entry) => [entry.kind, entry.displayName]), [['text', 'notes.txt'], ['image', 'pic1.png']]);
  assert.ok(!('text' in row.attachments[0]), 'file text never persists');
  assert.ok(Number.isInteger(row.event_seq) && row.event_seq > env.rows()[3].event_seq);

  assert.equal(env.emitted.length, 1);
  const { name, payload } = env.emitted[0];
  assert.equal(name, 'chat-stream');
  assert.deepEqual([payload.type, payload.streamId, payload.sessionId, payload.turnId], ['user_steer', 'stream_1', env.id, 'turn_1']);
  assert.deepEqual([payload.message.id, payload.message.kind, payload.message.content], ['steer_outbox_a1', 'steer', 'use this too']);
});

test('the ack ignores unknown, foreign and malformed ids, and a duplicate ack appends nothing', async (t) => {
  const env = await setup(t);
  env.seed();
  offer(env);
  assert.equal(acceptUserSteerConsumedNotification(env.ctx, { item_ids: ['outbox_zz', 'outbox_a1x', 'nope'] }), 0);
  for (const bad of [undefined, {}, { item_ids: 'outbox_a1' }, { item_ids: [1] }, { item_ids: Array.from({ length: 9 }, (_, i) => `outbox_${i}`) }]) {
    assert.equal(acceptUserSteerConsumedNotification(env.ctx, bad), 0, JSON.stringify(bad));
  }
  assert.equal(env.rows().length, 3);
  assert.equal(env.segmentCalls.length, 0, 'nothing consumed, no segment closed');

  assert.equal(acceptUserSteerConsumedNotification(env.ctx, { item_ids: ['outbox_a1', 'outbox_a1'] }), 1);
  assert.equal(acceptUserSteerConsumedNotification(env.ctx, { item_ids: ['outbox_a1'] }), 0);
  assert.equal(env.rows().filter((row) => row.kind === 'steer').length, 1);
  assert.equal(env.emitted.length, 1);
  assert.equal(acceptUserSteerConsumedNotification(null, { item_ids: ['outbox_a1'] }), 0);
});

test('the managed notification router routes session.user_steer_consumed to the steering ack', async (t) => {
  const env = await setup(t);
  env.seed();
  offer(env);
  handleNotification(env.ctx, { method: 'session.user_steer_consumed', params: { item_ids: ['outbox_a1'], iteration: 3 } }, {
    toolContext: {}, handleToolNotification: () => false,
  });
  assert.deepEqual(env.rows().map((row) => row.id).slice(-1), ['steer_outbox_a1']);
  assert.equal(env.logs.some((entry) => entry.event === 'chat.unknown_notification_method'), false);
});

test('a refused persist defers the steer row to the terminal suffix instead of leapfrogging it', async (t) => {
  const env = await setup(t);
  env.seed();
  offer(env);
  env.ctx.segmentPersistRefused = true;
  env.service.terminalCoordinator = { settle() {} };
  env.ctx.refusedTextSegments = [];
  assert.equal(acceptUserSteerConsumedNotification(env.ctx, { item_ids: ['outbox_a1'] }), 1);
  assert.equal(env.rows().some((row) => row.kind === 'steer'), false);
  assert.deepEqual(env.ctx.refusedTextSegments.map((row) => row.id), ['steer_outbox_a1']);
  assert.equal(env.emitted.length, 1, 'the bubble still shows live');

  const store = await setup(t);
  store.seed();
  offer(store);
  store.ctx.adapter.appendMessage = () => null; // the store refuses the write
  store.ctx.refusedTextSegments = [];
  acceptUserSteerConsumedNotification(store.ctx, { item_ids: ['outbox_a1'] });
  assert.equal(store.ctx.segmentPersistRefused, true);
  assert.deepEqual(store.ctx.refusedTextSegments.map((row) => row.id), ['steer_outbox_a1']);
});

test('the live payload goes through the stream emitter on the control channel when the ctx has one', async (t) => {
  const env = await setup(t);
  env.seed();
  const sent = [];
  env.ctx.emitChatStream = (payload, options) => sent.push({ payload, options });
  offer(env);
  offer(env, { itemId: 'outbox_a2', prompt: 'two' });
  acceptUserSteerConsumedNotification(env.ctx, { item_ids: ['outbox_a1'] });
  releaseUserSteers(env.ctx, 'cancel');
  assert.deepEqual(sent.map((entry) => entry.payload.type), ['user_steer', 'user_steer_released']);
  assert.deepEqual(sent.map((entry) => entry.options), [{ channel: 'control', phase: null }, { channel: 'control', phase: null }]);
  assert.equal(env.emitted.length, 0);
});

test('release returns the unconsumed ids once, with the reason, and ends the stream\'s steering', async (t) => {
  const env = await setup(t);
  env.seed();
  offer(env);
  offer(env, { itemId: 'outbox_a2', prompt: 'two' });
  offer(env, { itemId: 'outbox_a3', prompt: 'three' });
  acceptUserSteerConsumedNotification(env.ctx, { item_ids: ['outbox_a2'] });
  env.emitted.length = 0;

  assert.deepEqual(releaseUserSteers(env.ctx, 'terminal'), ['outbox_a1', 'outbox_a3']);
  assert.deepEqual(env.emitted, [{ name: 'chat-stream', payload: {
    type: 'user_steer_released', streamId: 'stream_1', sessionId: env.id, itemIds: ['outbox_a1', 'outbox_a3'], reason: 'terminal' } }]);
  assert.deepEqual(releaseUserSteers(env.ctx, 'terminal'), [], 'idempotent');
  assert.equal(env.emitted.length, 1);
  assert.equal(acceptUserSteerConsumedNotification(env.ctx, { item_ids: ['outbox_a1'] }), 0, 'a late ack after the release appends nothing');
  assert.equal(offer(env, { itemId: 'outbox_a9' }).ok, false);
  assert.deepEqual(releaseUserSteers({ service: env.service }, 'terminal'), [], 'a ctx without steering state');
  assert.deepEqual(releaseUserSteers(null, 'terminal'), []);
});

test('a newer stream of the same chat releases what an abandoned one held, as abandoned', async (t) => {
  const env = await setup(t);
  offer(env);
  const next = { service: env.service, resolvedSessionId: env.id, streamId: 'stream_2', turnId: 'turn_2' };
  attachMidTurnMail(next);
  attachUserSteer(next);
  assert.deepEqual(env.emitted.map((entry) => entry.payload), [{
    type: 'user_steer_released', streamId: 'stream_1', sessionId: env.id, itemIds: ['outbox_a1'], reason: 'abandoned' }]);
  assert.equal(env.ctx.userSteer.settled, true);
  assert.equal(next.userSteer.reserved.size, 0);
});

test('a steer row replays for the next turn as a plain user message in place, in session and recent scope', () => {
  const turn = (n, extra = []) => [
    { id: `u${n}`, role: 'user', content: `question ${n}` },
    { id: `a${n}`, role: 'assistant', content: `partial ${n}` },
    ...extra,
    { id: `f${n}`, role: 'assistant', content: `answer ${n}` },
  ];
  const steer = { id: 'steer_outbox_a1', role: 'user', kind: 'steer', turn_id: 'turn_6', content: 'also check the logs', outbox_item_id: 'outbox_a1',
    attachments: [{ id: 'att_1', kind: 'text', displayName: 'notes.txt' }] };
  const messages = [1, 2, 3, 4, 5].flatMap((n) => turn(n)).concat(turn(6, [steer]));
  for (const scope of ['session', 'recent']) {
    const history = buildPreparedContextHistory(messages, { history_scope: scope });
    const at = history.findIndex((message) => String(message.content).startsWith('also check the logs'));
    assert.ok(at > 0, scope);
    assert.deepEqual(Object.keys(history[at]).sort(), ['content', 'role'], scope);
    assert.equal(history[at].role, 'user', scope);
    // Its files are named, not resent, exactly like any earlier user message's.
    assert.match(history[at].content, /^also check the logs\n\n\[.*notes\.txt/, scope);
    assert.equal(history[at - 1].content, 'partial 6', scope);
    assert.equal(history[at + 1].content, 'answer 6', scope);
    // Six turns, one steer row: if the steer row started a group the first turn would fall out of "recent".
    assert.equal(history[0].content, 'question 1', scope);
  }
});

test('the offer and withdraw payloads are validated with the chat start rules', () => {
  const ok = { sessionId: 'sess_1', itemId: 'outbox_a1', prompt: 'hello', attachments: [] };
  assert.deepEqual(chatIpc.assertChatSteerIpcPayload(ok), ok);
  const logged = [];
  for (const bad of [null, [], 'x', { ...ok, extra: 1 }, { ...ok, sessionId: '' }, { ...ok, sessionId: 7 }, { ...ok, itemId: 'nope' },
    { ...ok, prompt: 7 }, { ...ok, attachments: {} }, { ...ok, attachments: new Array(65).fill({}) }]) {
    assert.throws(() => chatIpc.assertChatSteerIpcPayload(bad, { log: (...args) => logged.push(args) }), TypeError, JSON.stringify(bad));
  }
  assert.ok(logged.length > 0);
  assert.deepEqual(chatIpc.assertChatSteerWithdrawIpcPayload({ sessionId: 'sess_1', itemId: 'outbox_a1' }), { sessionId: 'sess_1', itemId: 'outbox_a1' });
  for (const bad of [null, {}, { sessionId: 'sess_1' }, { sessionId: 'sess_1', itemId: 'x' }, { sessionId: 'sess_1', itemId: 'outbox_a1', extra: 1 }]) {
    assert.throws(() => chatIpc.assertChatSteerWithdrawIpcPayload(bad), TypeError, JSON.stringify(bad));
  }
});

test('the steering channels are bridge invokes and their handlers answer refusals, never throw to the renderer', async (t) => {
  assert.equal(getBridgeChannel('chat.offerSteer', 'invoke'), 'chat:offer-steer');
  assert.equal(getBridgeChannel('chat.withdrawSteer', 'invoke'), 'chat:withdraw-steer');
  const env = await setup(t);
  const handlers = new Map();
  chatIpc.registerChatStreamIpcHandlers({ handle: (channel, handler) => handlers.set(channel, handler) }, {
    backendService: env.service, log: () => {},
    ipcAuthorization: { authorize: () => true, unauthorizedResult: () => ({ ok: false }) },
  });
  const offerHandler = handlers.get('chat:offer-steer');
  const withdrawHandler = handlers.get('chat:withdraw-steer');
  const event = { sender: { id: 1 } };
  assert.deepEqual(await offerHandler(event, { sessionId: env.id, itemId: 'outbox_a1', prompt: 'live', attachments: [] }), { ok: true });
  assert.equal(env.client.arrived[0].items[0].content, 'live');
  assert.deepEqual(await offerHandler(event, { sessionId: env.id, itemId: 'bad', prompt: 'x', attachments: [] }), { ok: false, reason: 'invalid' });
  assert.deepEqual(await offerHandler(event, null), { ok: false, reason: 'invalid' });
  assert.deepEqual(await withdrawHandler(event, { sessionId: env.id, itemId: 'outbox_a1' }), { ok: true });
  assert.deepEqual(await withdrawHandler(event, { sessionId: env.id, itemId: 'outbox_zz' }), { ok: false, reason: 'unknown' });
  assert.deepEqual(await withdrawHandler(event, 'junk'), { ok: false, reason: 'unknown' });
});

test('mid_turn_steer is a default-on flag with the JENNY_ENABLE_MID_TURN_STEER=0 kill switch', () => {
  assert.equal(buildFeatureFlags({}).mid_turn_steer, true);
  assert.equal(buildFeatureFlags({ JENNY_ENABLE_MID_TURN_STEER: '0' }).mid_turn_steer, false);
  assert.equal(buildFeatureFlags({ JENNY_ENABLE_MID_TURN_STEER: '1' }).mid_turn_steer, true);
});
