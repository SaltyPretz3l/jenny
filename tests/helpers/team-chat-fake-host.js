'use strict';

// The desktop chat client's test host (slice 2a-4b): the real host chat
// composition (services/host/team-chat-host.js: the real TeamChatStore, the
// real chat dispatcher with its limits, idempotency, byte bounds and events)
// in a temporary profile, behind a fake connection manager per member. The
// manager validates each command against the host's closed schema
// (server/api-contract.js validateCommand), dispatches it as the host's router
// would after authorization, and frames every published event the way the
// host's event stream does ({ event_type, cursor, boot_epoch, api_version,
// ...payload }, deep-frozen, delivered synchronously, audience-filtered). Tests
// can pause delivery (events are lost, cursors still advance, as a host whose
// replay window passed), change the boot epoch, inject raw events, put the
// member in another connection state (pending, reconnecting), and hook a
// command to refuse it, rewrite its answer or lose it. Plus manual timers, a
// manual defer queue, a member client file in a temporary profile and
// `startChats`, the chat clients over one fake manager. The overview lists the
// live `members` with their display names (slice 2a-4c).
//
// Why two harnesses: this one gives deterministic control of the host's
// answers and events (resume, outbox, hostile pages); team-chat-hook.js puts
// the same host dispatcher behind the real bridge, stream, feed and connection
// manager, for the IPC surface and removal through the real service.

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { API_VERSION, hostFailure, validateCommand } = require('../../server/api-contract');
const { deriveTeamId, keyPairFromSeed } = require('../../server/team/ids');
const { createTeamChatHost } = require('../../services/host/team-chat-host');
const { saveClientFile } = require('../../services/team/client-file');
const { createTeamChats } = require('../../services/team/team-chat');

const ME = Object.freeze({ member_id: 'member_meAAAA1111', device_id: 'device_meAAAA1111', role: 'member',
  display_name: 'Mika Member' });
const OTHER = Object.freeze({ member_id: 'member_otherBBB222', device_id: 'device_otherBBB222', role: 'member',
  display_name: 'Oona Other' });

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze(value[key]);
  }
  return value;
}

// setTimeout/clearTimeout that only run when the test says so (tests/helpers/fake-timers.js keeps a virtual
// clock instead; these never advance time, the test fires what is pending).
function createManualTimers() {
  const queue = [];
  const delays = [];
  return {
    delays,
    setTimeout(fn, ms) { const handle = { fn, ms, unref() {} }; queue.push(handle); delays.push(ms); return handle; },
    clearTimeout(handle) { const at = queue.indexOf(handle); if (at >= 0) queue.splice(at, 1); },
    pending: () => queue.length,
    // Runs every timer due now (a fired timer may schedule more; those wait for the next call).
    fire() { const due = queue.splice(0, queue.length); for (const handle of due) handle.fn(); return due.length; },
  };
}

// A defer that runs nothing until `run()`: proves a listener returned before any queued work.
function createManualDefer() {
  const queue = [];
  const defer = (fn) => { queue.push(fn); };
  defer.pending = () => queue.length;
  defer.run = () => { const due = queue.splice(0, queue.length); for (const fn of due) fn(); return due.length; };
  return defer;
}

function tempDir(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// A saved membership of `member` in a fresh team, in `userData`.
function writeMembership(userData, member = ME) {
  const hostKey = keyPairFromSeed(crypto.randomBytes(32)).publicKey;
  const record = {
    schema_version: 2, team_id: deriveTeamId(hostKey), host_public_key: hostKey, address_hints: ['192.0.2.7:4242'],
    last_addresses: ['192.0.2.7:4242'], member_id: member.member_id, device_id: member.device_id,
    display_name: 'Mika Member', joined_at: '2026-11-10T10:00:00.000Z', state_seen: 'active',
  };
  const saved = saveClientFile(userData, record);
  if (!saved.ok) throw new Error(`membership write failed: ${saved.reason}`);
  return record;
}

async function createChatFakeHost(t, { storeLimits, maxResponseBytes, members = [ME, OTHER] } = {}) {
  const profileDir = tempDir(t, 'jenny-team-chat-host-');
  const directory = {
    liveActor: (deviceId) => {
      const member = members.find((entry) => entry.device_id === deviceId);
      return member ? { ...member, state: 'active' } : null;
    },
    activeMemberIds: () => members.map((member) => member.member_id),
    // Slice 3-2: a team directory needs project roles; every member writes in every
    // project, so project channels stay open to all of them as before.
    projectRole: (memberId) => (members.some((member) => member.member_id === memberId) ? 'writer' : null),
    projectState: () => 'active',
  };
  const managers = new Set();
  let bootEpoch = 'boot_one';
  let cursor = 0;
  let admit = true;
  const publish = (type, payload, options = {}) => {
    cursor += 1;
    for (const manager of managers) manager.receive(type, payload, options, cursor);
  };
  // The overview's members (slice 2a-4c): the host's roster shape over the live `members` list.
  const roster = () => members.map((member) => ({ member_id: member.member_id,
    display_name: member.display_name || 'Mika Member', role: member.role }));
  const chat = createTeamChatHost({ profileDir, directory, publish, retentionIntervalMs: 0, roster,
    ...(storeLimits ? { storeLimits } : {}), ...(maxResponseBytes ? { maxResponseBytes } : {}) });
  const started = await chat.start();
  if (!started.ok) throw new Error('chat host did not start');
  t.after(() => chat.dispose());

  async function dispatch(member, operation, params, requestId) {
    const command = { api_version: API_VERSION, operation, params, client_id: 'client_fake', boot_epoch: bootEpoch,
      request_id: requestId || `req_${crypto.randomBytes(9).toString('base64url')}` };
    const valid = validateCommand(command);
    if (!valid.ok) return hostFailure('invalid', valid.reason);
    return chat.commands.dispatch(command, { deviceId: member.device_id }, { canAdmit: () => admit, publish });
  }

  function createManager(member = ME, teamId = 'team_fakeTeam000000000') {
    const listeners = new Set();
    const manager = {
      teamId, member, calls: [], state: 'online', paused: false, hook: null, onChange: null,
      onEvent(listener) { listeners.add(listener); return () => listeners.delete(listener); },
      snapshot: () => ({ team_id: teamId, state: manager.state, member_id: member.member_id }),
      async command(operation, params, { requestId } = {}) {
        manager.calls.push({ operation, params: JSON.parse(JSON.stringify(params)), requestId });
        if (manager.hook) {
          const hooked = await manager.hook({ operation, params, requestId, dispatch: () => dispatch(member, operation, params, requestId) });
          if (hooked) return hooked;
        }
        if (manager.state !== 'online') return { ok: false, error: { code: 'CMP-TEAM-0001', reason: 'team_not_connected' } };
        return dispatch(member, operation, params, requestId);
      },
      receive(type, payload, options, at) {
        if (options.audience && !options.audience.has(member.member_id)) return;
        if (manager.paused || manager.state !== 'online') return;
        manager.deliver({ event_type: type, cursor: at, boot_epoch: bootEpoch, api_version: API_VERSION, ...payload });
      },
      // Delivers one event to every listener, synchronously, as the feed does in the socket handler.
      deliver(event) {
        const frozen = deepFreeze(JSON.parse(JSON.stringify(event)));
        for (const listener of [...listeners]) listener(frozen);
      },
      setState(state) { manager.state = state; manager.onChange?.(); },
      listenerCount: () => listeners.size,
      ops: () => manager.calls.map((call) => call.operation),
    };
    managers.add(manager);
    return manager;
  }

  return {
    chat, store: chat.store, profileDir, members, createManager, dispatch,
    setAdmit(value) { admit = value; },
    setBootEpoch(value) { bootEpoch = value; },
    bootEpoch: () => bootEpoch,
    nextCursor: () => { cursor += 1; return cursor; },
    async postAs(member, text, extra = {}) {
      const answer = await dispatch(member, 'team.chat.post', { channel_id: 'chan_team', text, ...extra });
      if (!answer.ok) throw new Error(`post failed: ${answer.error.reason}`);
      return answer;
    },
  };
}

// The chat clients of `teamId` over one fake manager of `member`; stopped when the test ends.
function startChats(t, host, { userData, teamId, member = ME, online = true, timers = createManualTimers(), defer,
  now, pushes = [], logs = [] }) {
  const manager = host.createManager(member, teamId);
  if (!online) manager.state = 'reconnecting';
  const chats = createTeamChats({ userDataPath: userData, sendChat: (payload) => pushes.push(payload), timers,
    log: (level, event, fields) => logs.push({ level, event, fields }), ...(defer ? { defer } : {}),
    ...(now ? { now } : {}) });
  manager.onChange = () => chats.connectionChanged(teamId);
  chats.attach(teamId, manager);
  t.after(() => chats.stopAll());
  return { chats, manager, timers, pushes, logs };
}

// One turn of the event loop.
const tick = () => new Promise((resolve) => { setImmediate(resolve); });

// Lets queued work reach its next await (a few turns of the event loop).
async function settleChatsBriefly(turns = 5) {
  for (let n = 0; n < turns; n += 1) await tick();
}

// The promise's value, or 'still waiting' after `ms`.
async function within(promise, ms = 1500) {
  let timer;
  const late = new Promise((resolve) => { timer = setTimeout(() => resolve('still waiting'), ms); });
  try { return await Promise.race([promise, late]); } finally { clearTimeout(timer); }
}

// A fake host and the chat clients of a fresh membership over it, with the calls most tests make:
// `call(method, payload)` (the team id filled in), `sent(operation)` (the commands that reached the host),
// `ofType(type)` (the pushes of a type) and `event(type, payload)` (one host event delivered to the client).
async function setupChatClient(t, { host: hostOptions, prefix = 'jenny-team-chat-client-', ...startOptions } = {}) {
  const host = await createChatFakeHost(t, hostOptions);
  const userData = tempDir(t, prefix);
  const teamId = writeMembership(userData).team_id;
  const s = { host, teamId, userData, ...startChats(t, host, { userData, teamId, ...startOptions }) };
  s.call = (method, payload = {}) => s.chats.handle(method, { team_id: teamId, ...payload });
  s.sent = (operation) => s.manager.calls.filter((call) => call.operation === operation);
  s.ofType = (type) => s.pushes.filter((push) => push.type === type);
  s.event = (eventType, payload) => s.manager.deliver({ event_type: eventType, cursor: host.nextCursor(),
    boot_epoch: host.bootEpoch(), ...payload });
  return s;
}

// Runs queued work and every pending timer until nothing more is scheduled (bounded).
async function settleChats(chats, teamId, timers) {
  for (let round = 0; round < 20; round += 1) {
    await chats.idle(teamId);
    if (timers.fire() === 0) return;
  }
}

module.exports = {
  ME, OTHER, createChatFakeHost, createManualDefer, createManualTimers, deepFreeze, setupChatClient, settleChats, settleChatsBriefly,
  startChats, tempDir, tick, within,
  writeMembership,
};
