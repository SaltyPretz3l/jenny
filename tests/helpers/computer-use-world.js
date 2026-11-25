'use strict';

// The computer-use service's test harness (row 196): a scripted helper host, a program finder, the service
// with an instant hold limit, and the live tool context. Shared by tests/computer-use-service.test.js and
// tests/computer-use-owner-control.test.js.

const assert = require('node:assert/strict');
const os = require('node:os');
const { EventEmitter } = require('node:events');

const { SessionExecutionAuthority } = require('../../services/backend/session-execution-authority');
const { createComputerUseService } = require('../../services/computer-use/computer-use-service');

const GAME = 'C:\\Games\\Game\\game.exe';
const JENNY = 'C:\\Program Files\\Jenny\\Jenny.exe';
const CLICK = { action: 'click', x: 1, y: 1 };

const helperError = (code, reason) => Object.assign(new Error(code), { code, ...(reason ? { reason } : {}) });
const win = (hwnd, pid, title, extra = {}) => ({ hwnd, pid, title, visible: true, cloaked: false, tool_window: false, ...extra });

// A scripted stand-in for the helper host: the same `request` and EventEmitter shape, no process.
function makeWorld() {
  const world = {
    calls: [], errors: {}, frame: 0, still: false, onSleep: null,
    windows: [win(101, 11, 'Untitled - Game'), win(102, 12, 'Canvas - Paint'), win(103, 13, 'Docs - Chrome'), win(104, 14, 'Terminal')],
    programs: { 101: GAME, 102: 'C:\\Apps\\Paint\\paint.exe', 103: 'C:\\Program Files\\Chrome\\chrome.exe', 104: 'C:\\Tools\\python.exe' },
  };
  const host = new EventEmitter();
  host.request = async (op, args, options) => {
    world.calls.push({ op, args, options });
    const scripted = world.errors[op];
    if (scripted) throw scripted;
    if (op === 'windows.list') return { windows: world.windows.map((item) => ({ ...item })) };
    if (op === 'program.identify') return { hwnd: args.hwnd, pid: 1, program: world.programs[args.hwnd] ?? null, kind: 'desktop', elevated: false };
    if (op === 'capture') {
      return { png_base64: Buffer.from(`png-${world.frame}`).toString('base64'), width: 1280, height: 720, scale: 0.5, signature: `sig${world.frame}` };
    }
    if (op.startsWith('input.') && !['input.release_all', 'input.focus'].includes(op) && !world.still) world.frame += 1;
    return {};
  };
  world.host = host;
  world.ops = (op) => world.calls.filter((call) => call.op === op);
  world.names = () => world.calls.map((call) => call.op);
  world.reset = () => { world.calls.length = 0; };
  return world;
}

function makeFinder(table = {}, { launchOk = true, onLaunch = null } = {}) {
  const finder = {
    launched: [],
    find: async (name) => table[String(name).toLowerCase()] || [],
    async launch(match) {
      finder.launched.push(match);
      if (onLaunch) onLaunch(match);
      return launchOk ? { ok: true } : { ok: false, reason: 'start_failed' };
    },
  };
  return finder;
}

function setup({ options = {}, finder = makeFinder(), decline = [] } = {}) {
  const world = makeWorld();
  const clock = { t: 1000 };
  const asks = [];
  const authorize = async (params) => {
    const card = params.messageFields.computer_approval;
    asks.push({ kind: card.kind, name: card.program_name, program: card.program_path, view_only: card.view_only });
    clock.t += 500;
    return !decline.includes(card.kind);
  };
  const service = createComputerUseService({
    getHost: () => world.host, finder, jennyIdentity: () => ({ pids: [4100, 4188], programs: [JENNY] }),
    now: () => clock.t, sleep: async (ms, signal) => { if (world.onSleep) world.onSleep(ms, signal); }, settleMs: 5, hold: { setTimer: (fn) => { setImmediate(fn); return null; } }, ...options,
  });
  const ctx = (extra = {}) => ({
    sessionId: 'chat-1', turnId: 'turn-1', callId: 'call-1', abortSignal: new AbortController().signal, authorize, ...extra,
  });
  const run = (input, extra) => service.execute(input, ctx(extra));
  return { world, service, finder, asks, ctx, run };
}

// Focus the game, so the chat has a granted target and a picture this turn.
async function focused(s, extra) {
  const outcome = await s.run({ action: 'focus', name: 'game' }, extra);
  assert.equal(outcome.status, 'done', outcome.message);
  return outcome;
}

function liveContext({ messages = [], extra = {}, service = null } = {}) {
  const project = { project_id: 'p', root_path: os.tmpdir(), root_id: 'r', root_revision: 1, device_id: 'd', inode: 'i' };
  const authority = new SessionExecutionAuthority({
    projectAuthority: { captureSession: () => project, requireCurrent: (captured) => captured, _sessionStore: { getSessionSummary: () => ({ id: 'chat' }) } },
    permissionStore: { getSnapshot: () => ({ version: 1, legacy_policies: {}, rules: [] }) },
    knowledgeService: { getSidecarConfig: () => ({ knowledge_roots: [] }) },
    resolveProjectWorkspaceServices: () => ({}),
  });
  const calls = [];
  const suspendTurnClocks = () => () => {};
  const context = {
    sessionId: 'chat', streamId: 'stream', logicalTurnId: 'turn', sessionIncarnation: 'incarnation', callId: 'call-1',
    backendService: { sessionStore: { getActiveTurn: () => ({ stream_id: 'stream', turn_id: 'turn', session_incarnation: 'incarnation' }), peekSessionMessages: () => messages } },
    executionAuthority: authority.captureSession('chat', { requestId: 'stream', mode: 'assist', approvalMode: 'auto' }),
    computerUseService: service || { async execute(input, options) {
      calls.push({ input, options });
      return { ok: true, status: 'done', action: input.action, message: 'Clicked.', program: 'game' };
    } },
    authorize: async () => true, abortSignal: new AbortController().signal, suspendTurnClocks, ...extra,
  };
  return { context, calls, suspendTurnClocks };
}

const userRow = (content, extra = {}) => ({ id: `u${Math.random()}`, role: 'user', content, ...extra });

module.exports = { CLICK, GAME, JENNY, focused, helperError, liveContext, makeFinder, makeWorld, setup, userRow, win };
