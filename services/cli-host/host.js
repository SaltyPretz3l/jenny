'use strict';

const { composeCliBackend } = require('./composition');
const { CLI_ERROR_CODES, cliError } = require('./local-only-providers');

// Work stops moving on its own in these states; needs_attention waits for a
// person and paused waits for a resume, both of which a CLI caller must see
// rather than wait out.
const SETTLED_WORK_STATUSES = Object.freeze(new Set(['completed', 'failed', 'cancelled', 'needs_attention', 'paused']));
const WORK_POLL_MS = 50;
const DEFAULT_WORK_TIMEOUT_MS = 10 * 60_000;
const START_PURPOSE = 'Jenny CLI run';

// Clients reach the backend only through the port; tests and diagnostics in
// this process read the composition through this map.
const compositions = new WeakMap();

function hostStateError(reason) {
  return cliError(Error, CLI_ERROR_CODES.HOST_STATE, reason);
}

function workWaitError(reason, detail = {}) {
  return Object.assign(cliError(Error, CLI_ERROR_CODES.WORK_WAIT, reason), detail);
}

function createEventHub(backend) {
  const subscribers = new Set();
  const onChatStream = (event) => {
    for (const subscriber of subscribers) subscriber.push(event);
  };
  backend.on('chat-stream', onChatStream);
  let ended = false;

  function subscribe() {
    const queue = [];
    let wake = null;
    let done = ended;
    const subscriber = {
      push(event) {
        if (wake) { const resolve = wake; wake = null; resolve({ value: event, done: false }); }
        else queue.push(event);
      },
      end() {
        done = true;
        subscribers.delete(subscriber);
        if (wake) { const resolve = wake; wake = null; resolve({ value: undefined, done: true }); }
      },
    };
    if (!done) subscribers.add(subscriber);
    return {
      next() {
        if (queue.length) return Promise.resolve({ value: queue.shift(), done: false });
        if (done) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => { wake = resolve; });
      },
      return() {
        queue.length = 0;
        subscriber.end();
        return Promise.resolve({ value: undefined, done: true });
      },
      [Symbol.asyncIterator]() { return this; },
    };
  }

  function end() {
    ended = true;
    backend.off('chat-stream', onChatStream);
    for (const subscriber of [...subscribers]) subscriber.end();
  }

  return { subscribe, end };
}

/**
 * The in-process CLI host port. Every client (print mode, MCP serve, the
 * interactive loop) talks to this object only; events are the raw desktop
 * chat-stream events until the cli.v1 projection wraps them.
 */
function createCliHost(options) {
  const composition = composeCliBackend(options);
  const { backend, configService } = composition;
  const hub = createEventHub(backend);
  let closing = null;

  const assertOpen = () => { if (closing) throw hostStateError('host_closed'); };

  // The workspace project every CLI session binds to: a fallback to General
  // would leave filesystem tools without a root.
  function workspaceProject(reason) {
    assertOpen();
    const project = backend.ensureWorkspaceProject(configService.getToolsWorkspaceRoot(), reason);
    if (!project?.ok) throw Object.assign(hostStateError('workspace_project_unavailable'), { detail: project?.reason || null });
    return { project_id: project.project.id };
  }

  async function createSession({ title } = {}) {
    const { project_id: projectId } = workspaceProject('cli_session_create');
    const created = await backend.createSession({ title, projectId });
    return { session_id: created.data.id };
  }

  async function submit({ limits, ...request } = {}) {
    assertOpen();
    const service = backend.runtimeApplicationService;
    return limits === undefined ? service.submit(request)
      : service.start({ ...request, purpose: START_PURPOSE, limits });
  }

  async function waitForWork(workId, { timeoutMs = DEFAULT_WORK_TIMEOUT_MS } = {}) {
    const until = Date.now() + timeoutMs;
    for (;;) {
      assertOpen();
      const read = backend.runtimeApplicationService.getWork({ work_id: workId });
      if (!read.ok) throw workWaitError(read.error?.reason || 'work_read_failed');
      if (SETTLED_WORK_STATUSES.has(read.work.status)) return read.work;
      if (Date.now() >= until) throw workWaitError('work_wait_timeout', { status: read.work.status });
      await new Promise((resolve) => setTimeout(resolve, WORK_POLL_MS));
    }
  }

  // Revision-bound like every runtime control: the record is read first so a
  // cancel never races a settlement it did not see.
  async function cancel(workId) {
    assertOpen();
    const service = backend.runtimeApplicationService;
    const read = service.getWork({ work_id: workId });
    if (!read.ok) throw workWaitError(read.error?.reason || 'work_read_failed');
    if (SETTLED_WORK_STATUSES.has(read.work.status)) return { ok: true, work_id: workId, status: read.work.status, settled: true };
    return service.cancel({ work_id: workId, expected_revision: read.work.revision });
  }

  function close() {
    closing ||= (async () => {
      hub.end();
      return composition.close();
    })();
    return closing;
  }

  const port = Object.freeze({
    start: async (startOptions) => { assertOpen(); await backend.start(startOptions); },
    workspaceProject,
    createSession,
    submit,
    cancel,
    events: () => hub.subscribe(),
    waitForWork,
    close,
  });
  compositions.set(port, composition);
  return port;
}

function hostComposition(port) {
  const composition = compositions.get(port);
  if (!composition) throw hostStateError('unknown_host');
  return composition;
}

module.exports = { SETTLED_WORK_STATUSES, createCliHost, hostComposition };
