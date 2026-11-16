'use strict';

// Team boards (row 151): everything the team host builds for boards, in one place. `server/team/team-main.js` calls
// this once and wires these things from the answer; the board slices add their parts here, not there.
//
//   store            the host board store (team-boards.js): the project deleter removes a project's boards through it
//   commands         the team.board.* family for createTeamCommands (board-commands.js)
//   admitChat        `chat.send` with a board id, for createTeamCommands (board-turn-ports.js)
//   routes           the raw board routes for the host's route chain: true when one took the request
//                    (board-routes.js, the snapshot; board-asset-routes.js, a picture up and down;
//                    board-import-route.js, a board copied in whole)
//   sweeps           the background work for the host's sweep timer, as [failure event, task] pairs
//   attach           after the host core exists: the backend's board ports for a turn (slice T5), the membership
//                    drops and the presence sweep (slice T4). Answers what undoes them.
//   onMemberStream   each member stream's open and close: a device's last close drops its viewing and its locks
//   dropForProject   the project change subscriber: a member who lost the project, or a project being deleted
//
// Presence (who is viewing, pointers, note locks) is memory only (board-presence.js). The store has no timer: this
// module sweeps it every 10 seconds so a lease or a viewing record that ran out is announced.
//
// Pictures are also swept every hour here, beside the host's daily sweep: a full project makes room only from
// pictures a sweep has already seen unused, so an upload nobody put on a card holds the allowance for an hour, not
// for a day.

const { REVOKE_EVENT_KINDS } = require('../membership-events');
const { isId } = require('../ids');
const { safeLogger } = require('../safe-logger');
const { createBoardAssetRoutes } = require('./board-asset-routes');
const { batchRules, createTeamBoardCommands } = require('./board-commands');
const { createBoardEvents } = require('./board-events');
const { createBoardImportRoute } = require('./board-import-route');
const { createTeamBoardAssets } = require('./board-host-assets');
const { createBoardPresence } = require('./board-presence');
const { createPresenceOperations } = require('./board-presence-ops');
const { createHostProposals } = require('./board-proposals-host');
const { createBoardRoutes } = require('./board-routes');
const { createBoardTurnPorts } = require('./board-turn-ports');
const { createTeamBoards } = require('./team-boards');

const PRESENCE_SWEEP_MS = 10_000;
const PICTURE_SWEEP_MS = 60 * 60 * 1000;
const PROJECT_CHANGE_REASONS = new Set(['members', 'deleting', 'deleted']);
const DELETE_REASONS = new Set(['deleting', 'deleted']);
// A member whose team role changed views again at their next heartbeat, under the role they have now.
const PRESENCE_DROP_KINDS = new Set(['role_changed']);

/**
 * userDataPath: the host profile. directory: the member directory. sessionProject(id): the project a conversation is
 * in, or null. audit(entry): appends one project audit entry, answering { ok } (team-approvals.js `append`).
 * assertSafePath: the host's guard for a path it is about to use. diskRoots (and statfs, for tests): what the upload's
 * disk gate measures, as for chat attachments. Nothing reads the disk until a call asks. For tests: `limits`
 * ({ commands, events, route, imports }) replaces rate limits, `wrap(store)` what the commands, routes and proposals are
 * given, `timers` the presence sweep's timer and `presenceClock` the presence store's monotonic clock.
 */
function createTeamBoardHost({
  userDataPath, directory, sessionProject, publish, audit, clock = Date.now, logger = null, assertSafePath, diskRoots = [], statfs,
  limits = {}, wrap = (store) => store, timers = { setInterval, clearInterval }, presenceClock,
} = {}) {
  const say = safeLogger(logger);
  // Every applied batch and list change is announced from inside the store (board-events.js).
  const events = createBoardEvents({ publish, directory, clock, logger, limits: limits.events });
  const store = createTeamBoards({ userDataPath, clock, logger, assertSafePath, onChange: events.onChange });
  const served = wrap(store);
  const presence = createBoardPresence(presenceClock ? { clock: presenceClock } : {});
  const live = createPresenceOperations({ presence, publish, directory, logger });
  const proposals = createHostProposals({ boards: served, audit, batchRefusal: batchRules({ sessionProject, presence }),
    announce: events.proposalsChanged, clock, logger });
  const commands = createTeamBoardCommands({ boards: served, directory, sessionProject, audit, presence,
    presenceOperations: live.operations, proposals, clock, logger, limits: limits.commands });
  const turns = createBoardTurnPorts({ boards: served, proposals, sessionProject, logger });
  const snapshot = createBoardRoutes({ boards: served, clock, logger, ...(limits.route ? { limit: limits.route } : {}) });
  // Pictures (slice T6). `refs` calls the store's scan in the same synchronous stretch, so the sweep decides which
  // pictures go while no board write can land in between.
  const assets = createTeamBoardAssets({ userDataPath, clock, logger, assertSafePath,
    refs: (projectId, use) => store.assetRefs({ projectId, use }) });
  const pictures = createBoardAssetRoutes({ boards: served, assets, clock, logger, diskRoots, statfs });
  const imports = createBoardImportRoute({ boards: served, sessionProject, clock, logger, diskRoots, statfs,
    ...(limits.imports ? { limits: limits.imports } : {}) });

  // What the presence store dropped is told to the project's members; nothing here can throw into a caller.
  function dropped(drop) {
    try { live.announce(drop()); } catch { say('WARN', 'team_board.presence_drop_failed'); }
  }

  const streams = new Map(); // device id -> its open member streams
  function onMemberStream(_memberId, deviceId, change) {
    if (!isId('device', deviceId)) return;
    const count = streams.get(deviceId) ?? 0;
    if (change === 'open') streams.set(deviceId, count + 1);
    else if (change === 'close' && count > 1) streams.set(deviceId, count - 1);
    else if (change === 'close' && count === 1) {
      streams.delete(deviceId);
      dropped(() => presence.dropDevice(deviceId));
    }
  }

  function dropForProject(event) {
    if (!PROJECT_CHANGE_REASONS.has(event?.reason) || typeof event.project_id !== 'string') return;
    if (DELETE_REASONS.has(event.reason)) { dropped(() => presence.dropProject(event.project_id)); return; }
    const members = new Set(Array.isArray(event.member_ids) ? event.member_ids : []);
    dropped(() => presence.dropWhere(({ projectId, memberId }) => projectId === event.project_id && members.has(memberId)));
  }

  function attach({ core, store: memberStore }) {
    const detachTurns = turns.attach(core.composition.backend);
    const unsubscribe = memberStore.onMembershipChange((event) => {
      if (!REVOKE_EVENT_KINDS.has(event.kind) && !PRESENCE_DROP_KINDS.has(event.kind)) return;
      for (const deviceId of event.device_ids) dropped(() => presence.dropDevice(deviceId));
    });
    const timer = timers.setInterval(() => dropped(() => presence.expire()), PRESENCE_SWEEP_MS);
    timer?.unref?.();
    let sweeping = false; // one picture sweep at a time; the store answers and never throws
    const pictureTimer = timers.setInterval(() => {
      if (sweeping) return;
      sweeping = true;
      Promise.resolve().then(() => assets.sweep()).then((out) => { if (out?.ok !== true) throw new Error('unavailable'); })
        .catch(() => say('WARN', 'team.board_asset_sweep_failed')).finally(() => { sweeping = false; });
    }, PICTURE_SWEEP_MS);
    pictureTimer?.unref?.();
    return [detachTurns, unsubscribe, () => timers.clearInterval(timer), () => timers.clearInterval(pictureTimer)];
  }

  return Object.freeze({
    store,
    commands,
    admitChat: turns.admitChat,
    routes: async (ctx) => (await snapshot(ctx)) || (await pictures(ctx)) || imports(ctx),
    // The store's sweep answers instead of throwing: one that could not run is a failed sweep to the timer's log.
    sweeps: Object.freeze([Object.freeze(['team.board_sweep_failed', async () => {
      if ((await store.sweep())?.ok !== true) throw new Error('team_board_sweep_unavailable');
    }]),
      Object.freeze(['team.board_asset_sweep_failed', () => assets.sweep()])]),
    attach,
    onMemberStream,
    dropForProject,
    presence, // read by tests
    events, // read by tests
  });
}

module.exports = { PICTURE_SWEEP_MS, PRESENCE_SWEEP_MS, createTeamBoardHost };
