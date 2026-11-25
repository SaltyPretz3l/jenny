'use strict';

/*
 * run-view-composition.js — the Live tab's per-profile holder (row 197, R2).
 *
 * Nothing loads at startup: the helper host, the run command store and the run
 * service are built on the first Live-tab call. The command store alone is
 * built for a project delete, so a deleted project's saved command goes even
 * when no run happened this session. The helper process starts only when the
 * run service first asks it for something.
 *
 * R3c: the holder also measures how much graphics memory a running program
 * holds (two samples per run) and warns at Run when less than that is free.
 * Both use modules that load only when first needed.
 */

const { isLive, isResting } = require('../run-view/run-state'); // a pure module with no requires

const STATE_METHOD = 'runView.onState';
const KEEP_FRAME_METHOD = 'runView.onKeepLastFrame';
const NEVER_START = new Set(['disabled', 'unsupported_platform']);
const MAX_SEEN = 256;
const SAMPLE_AT_MS = Object.freeze([20_000, 60_000]); // after the window shows
const SAMPLE_STATES = new Set(['running', 'minimized']); // a pair is scheduled on entering one of these
const PUSH_METHODS = Object.freeze({
  'run-view:state': STATE_METHOD,
  'run-view:keep-last-frame': KEEP_FRAME_METHOD,
});

// The host and the service log with logger.warn(message); main logs with log(level, event, fields).
function loggerFor(log) {
  const write = (level) => (message) => {
    try { log?.(level, 'run_view.log', { message: String(message).slice(0, 500) }); } catch { /* logging never throws */ }
  };
  return { debug: () => {}, info: write('INFO'), warn: write('WARN'), error: write('ERROR') };
}

// The project's root, from the same authority the tools use. Null for a project with no folder.
function bindingFor(getBackendService, projectId) {
  let authority;
  try {
    authority = getBackendService()?.projectAuthority?.captureProject?.(projectId);
  } catch {
    return null;
  }
  if (!authority || typeof authority.root_path !== 'string' || authority.root_path === '') return null;
  return { rootPath: authority.root_path, rootId: authority.root_id, rootRevision: authority.root_revision };
}

function createLazyRunView({
  userDataPath, getBackendService, sendBridgeEvent, log, platform = process.platform, modules = null, now = Date.now,
  isPackaged = null, listGpuHolders = null, probeFreeMb = null, setTimeout: setTimer = setTimeout, clearTimeout: clearTimer = clearTimeout,
} = {}) {
  const load = modules || (() => ({
    ...require('../run-view'),
    createComputerHelperHost: require('../computer-helper').createComputerHelperHost,
  }));
  // The two small stores load on their own: a turn's tool check or a project delete never pulls in the run
  // service, the helper host or their modules.
  const storeModules = modules || (() => ({
    createRunCommandStore: require('../run-view/run-command-store').createRunCommandStore,
    createRunGpuMemoryStore: require('../run-view/run-gpu-memory').createRunGpuMemoryStore,
  }));
  const logger = loggerFor(log);
  // A source checkout (not packaged) can build the screen helper; the Live tab words its notice by this.
  const packagedBuild = () => {
    if (typeof isPackaged === 'boolean') return isPackaged;
    try { return require('electron').app?.isPackaged === true; } catch { return false; }
  };
  let parts = null;
  let store = null;
  let captureSource = () => null;
  let startGate = () => 'disabled';
  let tracker = null;
  const generations = new Map(); // projectId -> the newest generation a state push carried
  // projectId -> what the last state push said, for the chat's Runs list. Kept from the pushes, so
  // reading it never builds the run service; bounded like the generations.
  const seen = new Map();
  let gpuStore = null;
  const sampling = new Map(); // projectId -> { generation, timers, best } while a run is live

  const commandStore = () => {
    if (!store) store = storeModules().createRunCommandStore({ userDataPath });
    return store;
  };

  const gpuMemoryStore = () => {
    if (!gpuStore) gpuStore = storeModules().createRunGpuMemoryStore({ userDataPath });
    return gpuStore;
  };

  // ── graphics memory (R3c) ──
  const stopSampling = (projectId) => {
    const entry = sampling.get(projectId);
    if (!entry) return;
    sampling.delete(projectId);
    for (const timer of entry.timers) clearTimer(timer);
  };

  // One holder lookup at a time: a sample that comes due while one runs shares its answer.
  let holdersInFlight = null;
  const readHolders = () => {
    if (!holdersInFlight) {
      const list = listGpuHolders || (() => require('../gpu-memory-holders').listGpuMemoryHolders({ platform }));
      holdersInFlight = Promise.resolve().then(list).finally(() => { holdersInFlight = null; });
    }
    return holdersInFlight;
  };

  // What the program (and anything it started) holds on the card now. Keeps the biggest figure of the run.
  async function sampleGpu(projectId, entry) {
    try {
      const pid = parts?.service?.pidOf?.(projectId);
      if (!Number.isSafeInteger(pid) || pid <= 0) return;
      // The program and what it started (the helper's job list); the program alone when that cannot be read.
      const jobPids = await parts.service.jobPids?.(projectId);
      const ours = new Set([pid, ...(Array.isArray(jobPids) ? jobPids : [])]);
      const holders = await readHolders();
      if (sampling.get(projectId) !== entry) return; // the run ended while the lookup ran
      let mb = 0;
      for (const holder of holders) {
        if (ours.has(holder.pid) || holder.chain?.some((link) => ours.has(link.pid))) mb += Number(holder.mb) || 0;
      }
      mb = Math.round(mb);
      if (mb > entry.best && gpuMemoryStore().record(projectId, mb).ok) entry.best = mb;
    } catch { /* a missing sample is only a missing figure */ }
  }

  // A state push: a run that shows a window gets two samples; one that leaves the live states loses them.
  function noteSampling({ projectId, state, generation }) {
    if (platform !== 'win32') return;
    if (!isLive({ state })) { stopSampling(projectId); return; } // a pair lives only while the run is live
    if (!SAMPLE_STATES.has(state) || sampling.get(projectId)?.generation === generation) return;
    stopSampling(projectId);
    const entry = { generation, timers: [], best: 0 };
    sampling.set(projectId, entry);
    for (const ms of SAMPLE_AT_MS) {
      const timer = setTimer(() => { void sampleGpu(projectId, entry); }, ms);
      timer?.unref?.();
      entry.timers.push(timer);
    }
  }

  // Free graphics memory on the largest card in MB, or null when it cannot be read.
  async function stockFreeMb() {
    const { largestGpuDevice, probeNvidiaSmiVram } = require('../gpu-vram-probe');
    const device = largestGpuDevice(await probeNvidiaSmiVram());
    return device ? device.totalMb - device.usedMb : null;
  }

  // null, or { needMb, freeMb } when less is free than the program used last time. This is advice, so it
  // fails open. It is not a model-loaded check: low free memory warns whatever is holding the card.
  async function startWarning(projectId) {
    try {
      const needMb = gpuMemoryStore().get(projectId);
      if (!needMb) return null;
      const freeMb = await (probeFreeMb || stockFreeMb)();
      if (!Number.isFinite(freeMb) || !(freeMb < needMb)) return null;
      return { needMb, freeMb: Math.max(0, Math.round(freeMb)) };
    } catch {
      return null;
    }
  }

  const armWindowCapture = async (sourceId) => {
    const handler = captureSource();
    if (!handler || typeof handler.armWindowCapture !== 'function') return { ok: false, reason: 'unavailable' };
    return handler.armWindowCapture(sourceId);
  };

  // A reason a program may not start, or null. Fails closed: no gate set, or a gate that throws, is `disabled`.
  const startRefusal = () => {
    try { return startGate() || null; } catch { return 'disabled'; }
  };

  // The turn-end restart keeps the model's restart tool's turn rules: normal safety mode, not Plan or
  // read-only (Propose) mode, no offline lockdown, and a turn a person started. Anything that cannot be
  // read refuses (fail closed).
  function turnRefusal(sessionId) {
    try {
      const backend = getBackendService();
      if (require('../backend/run-view-tool-gate').safetyModeOf(backend) !== 'normal') return 'safety_mode';
      const summary = backend?.sessionStore?.getSessionSummary?.(sessionId);
      if (!summary) return 'no_session';
      if (summary.plan_mode === true || String(summary.run_mode || '').trim().toLowerCase() === 'plan') return 'plan_mode';
      if (require('../backend/propose-mode').isProposeRunMode(summary)) return 'read_only';
      if (require('../backend/session-lockdown-gate').isSessionOfflineLockdownActive(backend.featureFlags, summary)) return 'lockdown';
      if (require('../tools/builtin/unattended-turn').isUnattendedTurn({ backendService: backend }, sessionId)) return 'unattended';
      return null;
    } catch {
      return 'turn_unreadable';
    }
  }

  // Small and pure (no host, no store): made on first need, without the run service or the helper.
  const restartTracker = () => {
    if (!tracker) {
      tracker = require('../run-view/restart-after-changes').createRestartAfterChanges({
        getRunService: () => parts?.service || null, canStart: startRefusal, turnRefusal, logger,
      });
    }
    return tracker;
  };

  // The chats whose Runs list shows this run: the chat that started it now, and the one before when it moved.
  const notifyChats = (chatIds) => {
    let workspace;
    try { workspace = getBackendService()?.chatWorkspace || null; } catch { return; }
    for (const chatId of new Set(chatIds)) {
      if (typeof chatId !== 'string' || chatId === '') continue;
      try { workspace?.notifyCoordinationChanged?.(chatId); } catch { /* a refetch is best effort */ }
    }
  };

  // What the Runs list reads: state, generation, chat, exit code, when the generation began and when it came to rest.
  const noteSeen = (payload, now) => {
    const before = seen.get(payload.projectId) || null;
    const fresh = !before || payload.generation !== before.generation;
    const resting = isResting(payload);
    const entry = {
      projectId: payload.projectId,
      chatId: typeof payload.chatId === 'string' ? payload.chatId : '',
      state: payload.state,
      generation: payload.generation,
      exitCode: Number.isInteger(payload.exitCode) ? payload.exitCode : null,
      startedAtMs: fresh ? now : before.startedAtMs,
      endedAtMs: resting ? (before && !fresh && before.endedAtMs ? before.endedAtMs : now) : 0,
      label: fresh ? undefined : before.label, // the program's name, read once per generation by runsForChat
    };
    seen.delete(payload.projectId);
    seen.set(payload.projectId, entry);
    while (seen.size > MAX_SEEN) seen.delete(seen.keys().next().value);
    notifyChats([entry.chatId, before?.chatId]);
  };

  // A state push whose generation went up is a build beginning, whoever asked for it (the panel, the
  // model's restart tool, or a turn's end): that moves the restart-after-changes mark.
  const emit = (channel, payload) => {
    if (channel === 'run-view:state' && typeof payload?.projectId === 'string' && Number.isFinite(payload.generation)) {
      if (payload.generation > (generations.get(payload.projectId) ?? 0)) {
        generations.set(payload.projectId, payload.generation);
        while (generations.size > 256) generations.delete(generations.keys().next().value);
        try { restartTracker().markBuild(payload.projectId); } catch { /* bookkeeping never blocks a push */ }
      }
      try { noteSeen(payload, now()); } catch { /* bookkeeping never blocks a push */ }
      try { noteSampling(payload); } catch { /* a missing sample never blocks a push */ }
    }
    const method = PUSH_METHODS[channel];
    if (method) sendBridgeEvent?.(method, payload);
  };

  const projectOf = (sessionId) => {
    try {
      const id = getBackendService()?.projectAuthority?.captureSession?.(sessionId)?.project_id;
      return typeof id === 'string' && id !== '' ? id : '';
    } catch {
      return '';
    }
  };

  // A tool result of a chat turn: counts a change, and only a change. Never builds the run service.
  // Before the Live tab's first use this session no program can be running, and the first build sets
  // the mark anyway, so nothing is counted (and no session is read) until then.
  function noteToolResult({ sessionId, callId, toolName, success, metadata } = {}) {
    try {
      if (!parts) return;
      if (!restartTracker().isChange({ toolName, success, metadata })) return;
      if (NEVER_START.has(startRefusal())) return;
      const projectId = projectOf(sessionId);
      if (projectId) restartTracker().recordChange({ projectId, callId });
    } catch { /* the chat path never sees this */ }
  }

  // A turn ended: restarts a running program when the turn changed the project. Never throws.
  async function onTurnEnd({ sessionId, projectId, status } = {}) {
    try {
      const project = typeof projectId === 'string' && projectId !== '' ? projectId : projectOf(sessionId);
      return await restartTracker().onTurnEnd({ projectId: project, chatId: sessionId, status });
    } catch {
      return { restarted: false, reason: 'restart_failed' };
    }
  }

  function get() {
    if (parts) return parts.service;
    const m = load();
    const host = m.createComputerHelperHost({ logger });
    const service = m.createRunService({
      host, commandStore: commandStore(), armWindowCapture, emit, logger, isPackaged: packagedBuild(),
      // Worktree roots are not resolved yet: a worktree answers no project, never the main root.
      getProjectBinding: async (projectId, worktree) => (worktree == null ? bindingFor(getBackendService, projectId) : null),
    });
    parts = { host, service };
    return service;
  }

  async function onProjectDeleted(projectId) {
    try {
      tracker?.forget(projectId);
      generations.delete(projectId);
      stopSampling(projectId);
      const gone = seen.get(projectId);
      if (seen.delete(projectId)) notifyChats([gone?.chatId]);
    } catch { /* the delete goes on */ }
    try { gpuMemoryStore().forget(projectId); } catch { /* the delete goes on */ }
    if (parts) return parts.service.onProjectDeleted(projectId);
    try {
      return commandStore().deleteProject(projectId);
    } catch {
      return { ok: false, reason: 'delete_failed' };
    }
  }

  // The project root's saved command as the store reads it (worktree null, as the panel sends), or null.
  // Synchronous and cheap: the store reads its file once. It never builds the run service or the helper.
  function savedCommand(projectId) {
    const binding = bindingFor(getBackendService, projectId);
    if (!binding) return null;
    return commandStore().get({ projectId, rootId: binding.rootId, rootRevision: binding.rootRevision, worktree: null });
  }

  // Whether the project's root has a run command the owner confirmed.
  function hasConfirmedCommand(projectId) {
    try { return savedCommand(projectId)?.status === 'confirmed'; } catch { return false; }
  }

  // The program's file name for the Runs list ('' when the project has no saved command).
  function programLabel(projectId) {
    try {
      const program = savedCommand(projectId)?.command?.program;
      return typeof program === 'string' ? program.trim().split(/[\\/]/).pop().slice(0, 200) : '';
    } catch {
      return '';
    }
  }

  // The runs this chat started (or last restarted), newest first: what its Runs list shows. A run that
  // never began (generation 0) is not listed. Synchronous; never builds the run service or the helper.
  function runsForChat(sessionId) {
    if (typeof sessionId !== 'string' || sessionId === '') return [];
    const rows = [];
    for (const entry of seen.values()) {
      if (entry.chatId !== sessionId || !(entry.generation > 0)) continue;
      if (entry.label === undefined) entry.label = programLabel(entry.projectId);
      rows.push({ ...entry });
    }
    return rows.sort((a, b) => b.startedAtMs - a.startedAtMs);
  }

  // Close every run's window, end its job, then stop the helper. A holder never used does nothing.
  async function shutdown() {
    for (const projectId of [...sampling.keys()]) stopSampling(projectId);
    if (!parts) return;
    const { host, service } = parts;
    try { await service.stopAll(); } finally {
      service.dispose();
      await host.stop();
    }
  }

  return {
    get,
    peek: () => parts?.service || null,
    // Row 196: the one helper host, shared with the computer tool (services/main/computer-use-composition.js).
    helperHost: () => { get(); return parts.host; },
    livePids: () => (parts ? parts.service.livePids() : []),
    projectForPid: (pid) => {
      try { return parts ? parts.service.projectForPid(pid) || '' : ''; } catch { return ''; }
    },
    runsForChat,
    platform: () => platform,
    setCaptureSource: (getter) => { captureSource = typeof getter === 'function' ? getter : () => null; },
    setStartGate: (gate) => { startGate = typeof gate === 'function' ? gate : () => 'disabled'; },
    startRefusal,
    hasConfirmedCommand,
    startWarning,
    restartSwitch: { isOn: (projectId) => restartTracker().isOn(projectId), setOn: (args) => restartTracker().setOn(args) },
    noteToolResult,
    onTurnEnd,
    onProjectDeleted,
    shutdown,
  };
}

module.exports = { createLazyRunView, PUSH_METHODS };
