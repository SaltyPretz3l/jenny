'use strict';

/*
 * run-view-ipc.js — the live run view's IPC surface (row 197, R1-service).
 *
 * Channel names, strict payload validation, and the handler factory. Nothing is
 * registered here: services/main/run-view-ipc-registration.js does that. Every payload
 * is a plain object with only known keys; anything else is refused as
 * `bad_request` before the run service is called. The run command itself is
 * passed through, because the command store owns its validation.
 */

const { isResting } = require('./run-state');

const RUN_VIEW_CHANNELS = Object.freeze({
  get: 'run-view:get',
  confirmCommand: 'run-view:confirm-command',
  start: 'run-view:start',
  stop: 'run-view:stop',
  restart: 'run-view:restart',
  showWindow: 'run-view:show-window',
  armCapture: 'run-view:arm-capture',
  output: 'run-view:output',
  setRestartAfterChanges: 'run-view:set-restart-after-changes',
  state: 'run-view:state',
  keepLastFrame: 'run-view:keep-last-frame',
});

const MAX_ID_CHARS = 200;
const MAX_WORKTREE_CHARS = 1024;
const MODES = Object.freeze(['ask', 'force']);
const PLACES = Object.freeze(['front', 'behind']);
const BAD_REQUEST = Object.freeze({ ok: false, reason: 'bad_request' });

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

const idOk = (value) => typeof value === 'string' && value !== '' && value.length <= MAX_ID_CHARS;
const worktreeOk = (value) => value === null || (typeof value === 'string' && value !== '' && value.length <= MAX_WORKTREE_CHARS);

// Per field: its check, and whether it may be left out (then it takes `fallback`).
const FIELDS = Object.freeze({
  projectId: { check: idOk },
  chatId: { check: idOk },
  worktree: { check: worktreeOk, optional: true, fallback: null },
  mode: { check: (value) => MODES.includes(value) },
  place: { check: (value) => PLACES.includes(value) },
  command: { check: isPlainObject },
  on: { check: (value) => typeof value === 'boolean' },
  anyway: { check: (value) => typeof value === 'boolean', optional: true, fallback: false },
});

const REQUESTS = Object.freeze({
  [RUN_VIEW_CHANNELS.get]: { method: 'getStatus', fields: ['projectId', 'worktree'] },
  [RUN_VIEW_CHANNELS.confirmCommand]: { method: 'confirmCommand', fields: ['projectId', 'worktree', 'command'] },
  [RUN_VIEW_CHANNELS.start]: { method: 'start', fields: ['projectId', 'chatId', 'worktree', 'anyway'] },
  [RUN_VIEW_CHANNELS.stop]: { method: 'stop', fields: ['projectId', 'mode'] },
  [RUN_VIEW_CHANNELS.restart]: { method: 'restart', fields: ['projectId', 'chatId', 'worktree'] },
  [RUN_VIEW_CHANNELS.showWindow]: { method: 'showWindow', fields: ['projectId', 'place'] },
  [RUN_VIEW_CHANNELS.armCapture]: { method: 'armCapture', fields: ['projectId'] },
  [RUN_VIEW_CHANNELS.output]: { method: 'output', fields: ['projectId'] },
  [RUN_VIEW_CHANNELS.setRestartAfterChanges]: { method: 'setRestartAfterChanges', fields: ['projectId', 'on'] },
});

// The cleaned arguments, or null when the payload is not exactly the channel's shape.
function validate(payload, fieldNames) {
  if (!isPlainObject(payload)) return null;
  if (Object.keys(payload).some((key) => !fieldNames.includes(key))) return null;
  const args = {};
  for (const name of fieldNames) {
    const field = FIELDS[name];
    const value = payload[name] === undefined && field.optional ? field.fallback : payload[name];
    if (!field.check(value)) return null;
    args[name] = value;
  }
  return args;
}

// The graphics-memory advice, only for a start that would go ahead: a confirmed command and a run at rest.
// Anything else goes straight to the service, which answers with its own refusal. The advice fails open.
async function warningFor(runService, startWarning, args) {
  try {
    const status = await runService.getStatus({ projectId: args.projectId, worktree: args.worktree });
    if (status?.ok !== true || status.command?.status !== 'confirmed' || !isResting(status.run || {})) return null;
    return await startWarning(args.projectId);
  } catch {
    return null;
  }
}

// The switch is not the run service's: it lives in main's restart-after-changes tracker (`restartSwitch`).
// `startWarning(projectId)` answers null or { needMb, freeMb } (main's graphics-memory advice, run-view-composition.js).
// A start with a warning and no `anyway` starts nothing and says so; the service never sees `anyway`. Restart never warns.
function createRunViewIpcHandlers({ runService, restartSwitch, startWarning } = {}) {
  if (!runService) throw new TypeError('runService is required');
  const handlers = {};
  for (const [channel, { method, fields }] of Object.entries(REQUESTS)) {
    handlers[channel] = async (payload) => {
      const args = validate(payload, fields);
      if (!args) return { ...BAD_REQUEST };
      try {
        if (method === 'setRestartAfterChanges') return restartSwitch ? restartSwitch.setOn(args) : { ok: false, reason: 'unavailable' };
        if (method === 'start') {
          const { anyway, ...rest } = args;
          const warning = anyway !== true && startWarning ? await warningFor(runService, startWarning, args) : null;
          if (warning) return { ok: false, reason: 'low_gpu_memory', needMb: warning.needMb, freeMb: warning.freeMb };
          return await runService.start(rest);
        }
        const reply = await runService[method](args);
        if (method === 'getStatus' && reply?.ok === true) return { ...reply, restartAfterChanges: restartSwitch ? restartSwitch.isOn(args.projectId) : true };
        return reply;
      } catch {
        return { ok: false, reason: 'internal_error' };
      }
    };
  }
  return handlers;
}

module.exports = { RUN_VIEW_CHANNELS, createRunViewIpcHandlers };
