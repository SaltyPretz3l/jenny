'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const crypto = require('../services/remote/remote-crypto');
const contracts = require('../services/remote/remote-contracts');
const limits = require('../services/remote/remote-limits');
const { createControlLeases } = require('../services/remote/remote-control-leases');
const { createEventBuffer } = require('../services/remote/remote-event-buffer');
const { createRemoteControlService } = require('../services/remote/remote-control-service');

function event(seq, text = 'x') {
  return {
    v: 1,
    kind: 'event',
    event_seq: seq,
    type: 'delta',
    session_id: 'chat-1',
    payload: { text },
  };
}

test('event buffer replays at boundaries and evicts oldest entries by bytes', () => {
  let time = 0;
  const sampleBytes = Buffer.byteLength(JSON.stringify(event(1)), 'utf8');
  const buffer = createEventBuffer({
    limits: { REPLAY_MAX_BYTES: sampleBytes * 2, REPLAY_MAX_MS: 10_000 },
    now: () => time,
  });
  buffer.push(event(1));
  buffer.push(event(2));
  assert.deepEqual(buffer.since(0).events.map((item) => item.event_seq), [1, 2]);
  buffer.push(event(3));
  assert.equal(buffer.head(), 3);
  assert.equal(buffer.since(0).reason, 'resync_required');
  assert.deepEqual(buffer.since(1).events.map((item) => item.event_seq), [2, 3]);
  assert.deepEqual(buffer.since(3).events, []);
  assert.equal(buffer.since(4).reason, 'resync_required');
  time += 1;
});

test('event buffer eviction by age requires resync behind the retained boundary', () => {
  let time = 10;
  const buffer = createEventBuffer({
    limits: { REPLAY_MAX_BYTES: 100_000, REPLAY_MAX_MS: 50 },
    now: () => time,
  });
  buffer.push(event(1));
  time = 40;
  buffer.push(event(2));
  time = 61;
  assert.deepEqual(buffer.since(1).events.map((item) => item.event_seq), [2]);
  assert.equal(buffer.since(1).ok, true);
  time = 100;
  assert.equal(buffer.since(0).reason, 'resync_required');
  assert.deepEqual(buffer.since(2).events, []);
});

test('outbound backpressure closes a peer and forces its next resync', async () => {
  const backend = new EventEmitter();
  backend.sessionStore = {
    getSession: () => ({ id: 'chat-1', title: 'Chat', session_type: 'chat', archived_at: null }),
  };
  backend.getActiveTurnState = async () => null;
  const secret = crypto.randomSecret();
  const record = {
    relay_url: 'wss://relay.example',
    shared_sessions: ['chat-1'],
    devices: [{ device_id: 'device_id1', label: 'Phone', paired_at: 1, last_seen_at: 1 }],
  };
  const store = {
    load: async () => ({ ok: true }),
    getRecord: () => structuredClone(record),
    desktopSecret: () => new Uint8Array(secret),
    isDeviceTrusted: () => true,
    unshareSession: async () => ({ ok: true }),
  };
  let relayInput;
  let relayState = 'idle';
  let projectionEmit;
  const peers = [];
  const relay = {
    connect() { relayState = 'claimed'; relayInput.onStateChange('claimed'); },
    getState: () => relayState,
    send: () => true,
    closePeer: () => true,
    disconnect: () => { relayState = 'closed'; },
    message: (value) => relayInput.onMessage(value),
  };
  const factories = {
    createDeviceStore: () => store,
    createRelayClient: (input) => { relayInput = input; return relay; },
    createPairingService: () => ({ close() {}, status: () => ({ open: false }) }),
    createRemoteChatAdapter: () => ({
      transcriptPage: async () => ({ ok: true, data: { messages: [] } }),
    }),
    createRemoteDecisionAdapter: () => ({ pendingFor: () => ({ tool: [], questions: [], plan: [] }) }),
    createRemoteEventProjector: (input) => {
      projectionEmit = input.emit;
      return { dispose() {} };
    },
    createControlLeases,
    createEventBuffer,
    createCommandRouter: () => ({
      handle: async ({ command }) => ({
        resync: true,
        request_id: command.request_id,
        last_event_seq: command.payload.last_event_seq,
      }),
    }),
    createPeerSession(input) {
      let state = 'handshaking';
      const sent = [];
      const peer = {
        connectionId: input.connectionId,
        epoch: input.epoch,
        deviceId: 'device_id1',
        get state() { return state; },
        ready() { state = 'ready'; },
        close(closeReason) { state = 'closed'; input.onClose(closeReason); },
        handleFrame: async () => ({
          command: {
            v: 1,
            kind: 'command',
            request_id: 'request_1',
            operation: 'resync',
            payload: { last_event_seq: 0 },
          },
        }),
        sendPlaintext: async (value) => {
          sent.push(value);
          return peers.length === 1 ? false : true;
        },
        setLastAcked: () => true,
        settleCommand: () => {},
        sent,
      };
      peers.push(peer);
      return peer;
    },
  };
  const service = createRemoteControlService({
    backendService: backend,
    secureStore: {},
    featureFlags: () => ({ remote_control: true }),
    isPluginActive: () => true,
    isWindowAlive: () => true,
    now: () => 1,
    setTimer: (fn) => ({ fn }),
    clearTimer: () => {},
    portalOriginFor: () => 'https://relay.example',
    factories,
  });
  assert.equal((await service.enable()).ok, true);
  relay.message({ v: 1, kind: 'peer_open', connection_id: 'connect_1' });
  peers[0].ready();
  projectionEmit(contracts.buildEvent({
    eventSeq: 1, type: 'delta', sessionId: 'chat-1', payload: { text: 'hello' },
  }));
  for (let index = 0; index < 6; index += 1) await Promise.resolve();
  assert.equal(peers[0].state, 'closed');
  relay.message({ v: 1, kind: 'peer_open', connection_id: 'connect_2' });
  peers[1].ready();
  relay.message({
    v: 1, route_id: 'route_id1', connection_id: 'connect_2',
    epoch: peers[1].epoch, seq: 1, ciphertext: 'abcd',
  });
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
  assert.equal(peers[1].sent[0].error.code, contracts.ERROR_CODES.resync_required);

  let releaseQueued;
  let transported = false;
  peers[1].sendPlaintext = async (_value, { authorized } = {}) => new Promise((resolve) => {
    releaseQueued = () => {
      const allowed = authorized?.() !== false;
      transported = allowed;
      resolve(allowed);
    };
  });
  projectionEmit(contracts.buildEvent({
    eventSeq: 2,
    type: 'delta',
    sessionId: 'chat-1',
    payload: { text: 'queued' },
  }));
  while (!releaseQueued) await Promise.resolve();
  const unsharing = service.unshareSession('chat-1');
  releaseQueued();
  await unsharing;
  for (let index = 0; index < 4; index += 1) await Promise.resolve();
  assert.equal(transported, false);
  assert.equal(peers[1].state, 'ready');
  await service.dispose();
});
