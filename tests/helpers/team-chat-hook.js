'use strict';

// Team chat on the in-process team host of tests/helpers/team-client-host.js
// (slice 2a-4b): that host composes the team commands without chat, so this
// helper builds the real host chat composition (services/host/team-chat-host.js)
// over the host's own member directory and routes every team.chat.* command
// (and, slice 2a-4c, team.presence.set) to it through the host's `commandHook`,
// after the host's closed schema check. The overview lists the host's real
// roster (`chatRoster` over the member store). Events go to the host's real
// event stream with their audience, so they reach the member through the real
// bridge, stream, feed and connection manager. `commandAs` sends one chat
// command as another member's device (a registered client of that device).

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { hostFailure, validateCommand } = require('../../server/api-contract');
const { chatRoster, createTeamChatHost } = require('../../services/host/team-chat-host');

const isChatOperation = (operation) => typeof operation === 'string'
  && (operation.startsWith('team.chat.') || operation === 'team.presence.set');

async function attachTeamChat(t, host) {
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-team-chat-hook-'));
  const publish = (type, payload, options) => host.env.core.events.publish(type, payload, options);
  const chat = createTeamChatHost({ profileDir, directory: host.env.store.directory, publish, retentionIntervalMs: 0,
    roster: chatRoster(host.env.store) });
  const started = await chat.start();
  if (!started.ok) throw new Error('team chat did not start');
  host.env.dmParticipants = (channelId) => chat.store?.participantsOf(channelId);
  host.env.commandHook = (command) => {
    if (!isChatOperation(command?.operation)) return null;
    const valid = validateCommand(command);
    if (!valid.ok) return hostFailure('invalid', valid.reason, command.request_id);
    const entry = host.env.context.clients.clients.get(command.client_id);
    return chat.commands.dispatch(command, { deviceId: entry?.deviceId }, { canAdmit: () => true, publish });
  };
  t.after(async () => {
    host.env.commandHook = null;
    host.env.dmParticipants = null;
    await chat.dispose();
    fs.rmSync(profileDir, { recursive: true, force: true });
  });
  return chat;
}

let sequence = 0;
// client registry -> device id -> client id: one registered client per device (the registry caps clients per device).
const registered = new WeakMap();

// One chat command as `member`'s device, through the hook (the device registers a client once per registry).
async function commandAs(host, member, operation, params) {
  const { clients } = host.env.context;
  if (!registered.has(clients)) registered.set(clients, new Map());
  const ids = registered.get(clients);
  if (!ids.has(member.device_id)) ids.set(member.device_id, clients.register(member.device_id).client_id);
  sequence += 1;
  return host.env.commandHook({ api_version: 1, operation, request_id: `req_as_${sequence}`,
    client_id: ids.get(member.device_id), boot_epoch: host.env.core.bootEpoch, params });
}

module.exports = { attachTeamChat, commandAs };
