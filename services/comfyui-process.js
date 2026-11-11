'use strict';

// The ComfyUI process owner (row 127). One headless server lives for exactly one
// image: it is started on loopback with a run id inside --user-directory, proven
// to be ours through /system_stats, and its process tree is killed with proof
// right after the render. The render record is the sd.cpp one (image-engine.pid),
// so the existing reconcile, Model Library Clean up and quit-time kill cover it.

const fs = require('fs');
const path = require('path');
const childProcess = require('child_process');
const processUtils = require('./backend/process-utils');
const { sanitizeSpawnEnv } = require('./backend/sanitize-spawn-env');
const { createLineSplitter, sanitizeLine, isInside } = require('./image-engine-runner');
const { removeTree } = require('./fs-remove-no-follow');

const RUN_ID = /^img_[a-f0-9]{12}$/;
const BODY_CAP_BYTES = 1024 * 1024;
const REQUEST_TIMEOUT_MS = 2000;
const POLL_MS = 250;
const MAX_TAIL_LINES = 20;
const MAX_TAIL_BYTES = 4096;
const MAX_REMEMBERED = 16;
const LOOPBACK = '127.0.0.1';

function buildLaunchArgs({ mainPath, port, runDir }) {
  return ['-s', mainPath, '--listen', LOOPBACK, '--port', String(port), '--disable-auto-launch',
    '--user-directory', path.join(runDir, 'user'), '--output-directory', path.join(runDir, 'output'),
    '--temp-directory', path.join(runDir, 'temp'), '--input-directory', path.join(runDir, 'input'),
    '--disable-all-custom-nodes', '--disable-metadata'];
}

function flagValue(argv, flag) {
  const at = argv.indexOf(flag);
  if (at < 0 || at + 1 >= argv.length || argv.indexOf(flag, at + 1) >= 0) return null;
  return argv[at + 1];
}

// /system_stats reports the server's own sys.argv; the run id inside the
// --user-directory value proves this is the process this owner launched.
function checkIdentity(stats, { runDir, port, opId, platform = process.platform } = {}) {
  const argv = stats?.system?.argv;
  if (!Array.isArray(argv) || argv.length > 256 || !argv.every((arg) => typeof arg === 'string')) return false;
  if (typeof opId !== 'string' || !opId || typeof runDir !== 'string') return false;
  const fold = (value) => (platform === 'win32' ? value.replaceAll('/', '\\').toLowerCase() : value);
  const userDirectory = flagValue(argv, '--user-directory');
  return userDirectory !== null && flagValue(argv, '--port') === String(port)
    && fold(userDirectory) === fold(path.join(runDir, 'user')) && fold(userDirectory).includes(fold(opId));
}

async function readCapped(response) {
  if (!response.body?.getReader) {
    const text = await response.text();
    return text.length > BODY_CAP_BYTES ? null : text;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return Buffer.concat(chunks).toString('utf8');
    total += value.byteLength;
    if (total > BODY_CAP_BYTES) { await reader.cancel().catch(() => {}); return null; }
    chunks.push(value);
  }
}

function createComfyProcessOwner(options = {}) {
  const { userDataPath, log = () => {}, platform = process.platform, fsImpl = fs, spawnImpl = childProcess.spawn,
    fetchImpl = globalThis.fetch, getFreePort = processUtils.getFreePort, now = Date.now, sleep } = options;
  const pidfile = { ...require('./image-engine-pidfile'), ...options.pidfile };
  const processTools = { ...require('./backend/process-tree-tools'), ...options.processTools };
  const validateComfyFolder = options.validateComfyFolder || require('./image-model-sets').validateComfyFolder;
  const entries = new Map();
  const emit = (level, event, payload = {}) => {
    try { log(level, `comfyui.${event}`, payload); } catch (_error) { /* Diagnostics never interrupt a render. */ }
  };
  const clock = () => { try { const time = now(); return Number.isFinite(time) ? time : Date.now(); } catch (_error) { return Date.now(); } };
  const pause = (ms) => (sleep ? Promise.resolve().then(() => sleep(ms)) : new Promise((done) => { setTimeout(done, ms); }));

  const lstatOrNull = (target) => {
    try { return fsImpl.lstatSync(target); } catch (error) { if (error?.code === 'ENOENT') return null; throw error; }
  };
  const plainDirectory = (target) => { const stat = lstatOrNull(target); return !stat || (stat.isDirectory() && !stat.isSymbolicLink()); };

  // Creates <userData>/comfyui/runs/<opId>/{user,output,temp,input}; a link anywhere on the way is refused.
  function prepareRunDir(opId) {
    try {
      const base = path.join(userDataPath, 'comfyui');
      const runs = path.join(base, 'runs');
      const runDir = path.join(runs, opId);
      if (!plainDirectory(base) || !plainDirectory(runs)) return { ok: false, detail: 'run_dir_unsafe' };
      fsImpl.mkdirSync(runs, { recursive: true });
      fsImpl.mkdirSync(runDir, { recursive: true });
      const realRuns = fsImpl.realpathSync(runs);
      if (![base, runs, runDir].every((dir) => lstatOrNull(dir)?.isDirectory() && !lstatOrNull(dir).isSymbolicLink())
        || !isInside(fsImpl.realpathSync(userDataPath), realRuns) || !isInside(realRuns, fsImpl.realpathSync(runDir))) {
        return { ok: false, detail: 'run_dir_unsafe' };
      }
      for (const sub of ['user', 'output', 'temp', 'input']) fsImpl.mkdirSync(path.join(runDir, sub), { recursive: true });
      return { ok: true, runDir };
    } catch (_error) { return { ok: false, detail: 'run_dir_failed' }; }
  }

  // Recursive delete only of a verified <userData>/comfyui/runs/<opId> directory.
  async function removeRunDir(opId, runDir) {
    try {
      const base = path.join(userDataPath, 'comfyui');
      const runs = path.join(base, 'runs');
      if (!plainDirectory(base) || !plainDirectory(runs)) return false;
      const stat = lstatOrNull(runDir);
      if (!stat) return true;
      if (stat.isSymbolicLink() || !stat.isDirectory()) return false;
      const real = fsImpl.realpathSync(runDir);
      if (!isInside(fsImpl.realpathSync(runs), real) || path.basename(real) !== opId) return false;
      await removeTree(real, { fsImpl });
      return true;
    } catch (_error) { emit('WARN', 'run_dir_remove_failed', { opId }); return false; }
  }

  // With no render record, no run is live: run directories left by a crash, a
  // quit-time kill or a reconcile are orphans and go through the same checks.
  async function sweepRunDirs() {
    const runs = path.join(userDataPath, 'comfyui', 'runs');
    let names = [];
    try { if (plainDirectory(runs)) names = fsImpl.readdirSync(runs); } catch (_error) { return; }
    const live = (name) => entries.has(name) && !entries.get(name).stopPromise;
    for (const name of names.filter((entry) => RUN_ID.test(entry) && !live(entry))) {
      await removeRunDir(name, path.join(runs, name));
    }
  }

  async function requestJson(port, pathname, abortSignal) {
    try {
      const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
      const response = await fetchImpl(`http://${LOOPBACK}:${port}${pathname}`,
        { redirect: 'error', signal: abortSignal ? AbortSignal.any([timeout, abortSignal]) : timeout });
      const text = response.status === 200 ? await readCapped(response) : null;
      let body = null;
      try { body = text === null ? null : JSON.parse(text); } catch (_error) { /* Not JSON: not ready. */ }
      return { status: response.status, json: body && typeof body === 'object' ? body : null };
    } catch (_error) { return null; }
  }

  // ---- stop: tree kill with proof, mirroring the sd.cpp runner's settle path ----
  function finalizeStreams(entry) {
    return new Promise((done) => setImmediate(done)).then(() => {
      entry.stdout.flush();
      entry.stderr.flush();
      for (const [stream, listener] of [[entry.child.stdout, entry.onStdout], [entry.child.stderr, entry.onStderr]]) {
        try { stream?.removeListener('data', listener); stream?.destroy?.(); } catch (_error) { /* best effort */ }
      }
    });
  }

  async function reapSurvivors(entry, snapshot) {
    const rootHeldUntilMs = entry.exitedWallAt ?? Date.now();
    entry.tree = { spawnedAtMs: entry.spawnedAtMs, spawnReturnedAtMs: entry.spawnReturnedAtMs, rootHeldUntilMs,
      rootCreatedMs: snapshot.rootCreatedMs ?? null, survivors: [],
      processes: (Array.isArray(snapshot.processes) ? snapshot.processes
        : (snapshot.pids || []).map((pid) => ({ pid, createdMs: null }))).slice(0, 64) };
    let table = { ok: false, rows: [] };
    try { table = await processTools.listProcessRows(); } catch (_error) { /* Unavailable proof is never clean. */ }
    if (!table.ok) return false;
    const survivors = processTools.selectRootSurvivors({ rootPid: entry.pid, spawnedAtMs: entry.spawnedAtMs,
      spawnReturnedAtMs: entry.spawnReturnedAtMs, rootHeldUntilMs, snapshot, rows: table.rows });
    const created = new Map(table.rows.map((row) => [row.pid, row.createdMs ?? null]));
    entry.tree.survivors = survivors.pids.slice(0, 64).map((pid) => ({ pid, createdMs: created.get(pid) ?? null }));
    await processTools.terminatePids(survivors.pids);
    const proof = await processTools.confirmAllGone(survivors.pids);
    return snapshot.ok === true && survivors.ok === true && proof.confirmed === true;
  }

  async function killAndProve(entry) {
    const snapshot = async () => (entry.snapshotPromise ? entry.snapshotPromise
      : { ok: true, pids: [], processes: [], rootCreatedMs: null });
    if (entry.exited) return reapSurvivors(entry, await snapshot());
    const proof = await processTools.killTreeWithProof(entry.pid);
    let confirmed = proof.confirmed === true;
    if (proof.enumerated === true && Array.isArray(proof.survivors)) {
      entry.killSurvivors = proof.survivors.filter((pid) => Number.isSafeInteger(pid) && pid > 0 && pid !== entry.pid);
    }
    if (entry.snapshotPromise) {
      const early = await entry.snapshotPromise;
      const gone = await processTools.confirmAllGone(early.pids, { timeoutMs: 0 });
      if (gone.confirmed !== true) confirmed = (await reapSurvivors(entry, early)) && confirmed;
    }
    return confirmed;
  }

  async function runStop(entry) {
    let confirmed;
    try { confirmed = await killAndProve(entry); } catch (_error) { confirmed = false; }
    await finalizeStreams(entry).catch(() => {});
    if (confirmed) {
      try { if (entry.recorded) pidfile.clearOwnedRenderRecord(entry.pidPath, entry.opId, { fsImpl }); }
      catch (_error) { emit('WARN', 'record_clear_failed', { opId: entry.opId }); }
      await removeRunDir(entry.opId, entry.runDir);
    } else {
      emit('WARN', 'stop_unconfirmed', { opId: entry.opId, pid: entry.pid });
      try {
        if (entry.recorded && (entry.tree || entry.killSurvivors)) {
          const tree = entry.tree ?? { spawnedAtMs: entry.spawnedAtMs, spawnReturnedAtMs: entry.spawnReturnedAtMs,
            rootHeldUntilMs: entry.exitedWallAt ?? Date.now(), rootCreatedMs: null, processes: [], survivors: [] };
          const known = new Set(tree.survivors.map((item) => item.pid));
          const reported = (entry.killSurvivors || []).filter((pid) => !known.has(pid)).map((pid) => ({ pid, createdMs: null }));
          pidfile.retainRenderTree(entry.pidPath, entry.opId,
            { ...tree, survivors: [...tree.survivors, ...reported].slice(0, 64) }, { fsImpl });
        }
      } catch (_error) { emit('WARN', 'record_tree_failed', { opId: entry.opId }); }
    }
    emit('INFO', 'stopped', { opId: entry.opId, confirmed });
    return { confirmed };
  }

  function stopEntry(entry) {
    entry.stopPromise ??= runStop(entry).then((result) => {
      for (const [key, other] of entries) {
        if (entries.size <= MAX_REMEMBERED) break;
        if (other.stopPromise && key !== entry.opId) entries.delete(key);
      }
      return result;
    });
    return entry.stopPromise;
  }

  // Not async: concurrent and repeated calls for one run id return the very same promise.
  function stop(server) {
    const entry = typeof server?.opId === 'string' ? entries.get(server.opId) : null;
    if (!entry) { emit('WARN', 'stop_unknown_server'); return Promise.resolve({ confirmed: false }); }
    return stopEntry(entry);
  }

  // ---- start ----
  function newEntry({ child, opId, runDir, spawnedAtMs, spawnReturnedAtMs, port }) {
    const entry = { child, pid: child.pid, opId, runDir, port, spawnedAtMs, spawnReturnedAtMs, exited: false,
      exitedWallAt: null, recorded: false, ready: false, snapshotPromise: null, tail: [],
      pidPath: pidfile.getImageEnginePidPath(userDataPath), stopPromise: null, tree: null, killSurvivors: null };
    entry.exitedPromise = new Promise((done) => {
      child.on('exit', () => { entry.exited = true; entry.exitedWallAt ??= Date.now(); done(); });
    });
    child.on('error', () => { emit('WARN', 'child_error', { opId }); });
    const onLine = (line) => {
      entry.tail.push(sanitizeLine(line));
      while (entry.tail.length > MAX_TAIL_LINES || Buffer.byteLength(entry.tail.join('\n')) > MAX_TAIL_BYTES) entry.tail.shift();
    };
    entry.stdout = createLineSplitter(onLine, () => {});
    entry.stderr = createLineSplitter(onLine, () => {});
    entry.onStdout = (chunk) => entry.stdout.push(chunk);
    entry.onStderr = (chunk) => entry.stderr.push(chunk);
    child.stdout?.on('data', entry.onStdout);
    child.stderr?.on('data', entry.onStderr);
    return entry;
  }

  const refuse = (reason, detail, stderrTail = []) => ({ ok: false, reason, ...(detail ? { detail } : {}), stderrTail });

  async function failAndStop(entry, reason, detail) {
    const { confirmed } = await stopEntry(entry);
    return confirmed ? refuse(reason, detail, entry.tail.slice())
      : refuse('image_engine_cleanup_pending', detail, entry.tail.slice());
  }

  async function awaitReady(entry, { abortSignal, readyTimeoutMs, opId, runDir }) {
    const aborted = new Promise((done) => {
      if (abortSignal?.aborted) done(); else abortSignal?.addEventListener('abort', done, { once: true });
    });
    const deadline = clock() + readyTimeoutMs;
    for (;;) {
      if (abortSignal?.aborted) return { failure: await failAndStop(entry, 'image_cancelled') };
      if (entry.exited) return { failure: await failAndStop(entry, 'image_comfyui_start_failed', 'exited') };
      const reply = await requestJson(entry.port, '/system_stats', abortSignal);
      if (reply?.status === 200 && reply.json) {
        const trusted = checkIdentity(reply.json, { runDir, port: entry.port, opId, platform });
        return trusted ? { stats: reply.json } : { failure: await failAndStop(entry, 'image_comfyui_not_ours') };
      }
      if (clock() >= deadline) return { failure: await failAndStop(entry, 'image_comfyui_start_failed', 'ready_timeout') };
      await Promise.race([pause(POLL_MS), entry.exitedPromise, aborted]);
    }
  }

  async function startChecked({ comfy, opId, abortSignal, readyTimeoutMs }) {
    if (typeof opId !== 'string' || !RUN_ID.test(opId) || typeof userDataPath !== 'string' || !userDataPath) return refuse('image_comfyui_missing');
    const folder = validateComfyFolder(comfy?.folder, { fsImpl, platform });
    if (!folder?.ok) return refuse('image_comfyui_missing');
    // An existing render record is cleanup evidence no proof has cleared yet:
    // a new launch must never overwrite it (the caller reconciles first).
    if (pidfile.readRenderRecord(pidfile.getImageEnginePidPath(userDataPath), { fsImpl })) {
      return refuse('image_engine_cleanup_pending', 'render_record_present');
    }
    await sweepRunDirs();
    const prepared = prepareRunDir(opId);
    if (!prepared.ok) return refuse('image_comfyui_start_failed', prepared.detail);
    const { runDir } = prepared;
    const port = await getFreePort();
    if (abortSignal?.aborted) { await removeRunDir(opId, runDir); return refuse('image_cancelled'); }

    let child;
    const spawnedAtMs = Date.now();
    let spawnReturnedAtMs;
    try {
      child = spawnImpl(folder.pythonPath, buildLaunchArgs({ mainPath: folder.mainPath, port, runDir }), {
        cwd: folder.folder, shell: false, detached: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
        env: sanitizeSpawnEnv(process.env, { extraDeny: [/^PYTHON/i] }) });
      spawnReturnedAtMs = Date.now();
    } catch (_error) { await removeRunDir(opId, runDir); return refuse('image_comfyui_start_failed', 'spawn_failed'); }
    if (!Number.isSafeInteger(child?.pid) || child.pid <= 0) {
      child?.on?.('error', () => {});
      await removeRunDir(opId, runDir);
      return refuse('image_comfyui_start_failed', 'spawn_failed');
    }

    const entry = newEntry({ child, opId, runDir, spawnedAtMs, spawnReturnedAtMs, port });
    entries.set(opId, entry);
    try {
      pidfile.writeRenderRecord(entry.pidPath, { pid: child.pid, exePath: folder.pythonPath, opId,
        output: path.join(userDataPath, 'image-engine-scratch', `${opId}.png`), startedAt: clock(), treeSince: spawnedAtMs }, { fsImpl });
      entry.recorded = true;
    } catch (_error) { return failAndStop(entry, 'image_engine_launch_unrecorded'); }

    const readyStartedAt = clock();
    const outcome = await awaitReady(entry, { abortSignal, readyTimeoutMs, opId, runDir });
    if (outcome.failure) return outcome.failure;
    entry.ready = true;
    // The tree snapshot waits for readiness: by then ComfyUI has started any
    // helpers it will, and the process query no longer competes with torch's import.
    entry.snapshotPromise = Promise.resolve().then(() => processTools.enumerateDescendants(child.pid))
      .catch(() => ({ ok: false, pids: [] }));
    const version = outcome.stats.system?.comfyui_version;
    const server = { opId, pid: child.pid, port, baseUrl: `http://${LOOPBACK}:${port}`, runDir,
      outputDir: path.join(runDir, 'output'), comfyuiVersion: typeof version === 'string' ? version.slice(0, 64) : null,
      readyMs: Math.max(0, clock() - readyStartedAt) };
    emit('INFO', 'started', { opId, pid: child.pid, port, readyMs: server.readyMs, version: server.comfyuiVersion });
    return { ok: true, server };
  }

  async function start({ comfy, opId, abortSignal, readyTimeoutMs = 120000 } = {}) {
    try {
      return await startChecked({ comfy, opId, abortSignal, readyTimeoutMs });
    } catch (error) {
      emit('ERROR', 'start_threw', { opId: typeof opId === 'string' ? opId : null, code: error?.code || null });
      const entry = typeof opId === 'string' ? entries.get(opId) : null;
      if (entry) return failAndStop(entry, 'image_comfyui_start_failed', 'internal').catch(() => refuse('image_engine_cleanup_pending'));
      return refuse('image_comfyui_start_failed', 'internal');
    }
  }

  // ---- queries against the server this owner started (never a host from outside) ----
  const liveEntry = (server) => {
    const entry = typeof server?.opId === 'string' ? entries.get(server.opId) : null;
    return entry?.ready && !entry.stopPromise ? entry : null;
  };

  async function nodeInfo(entry, nodeType) {
    if (typeof nodeType !== 'string' || !nodeType) return { asked: true, info: null };
    const reply = await requestJson(entry.port, `/object_info/${encodeURIComponent(nodeType)}`);
    if (!reply) return { asked: false, info: null };
    return { asked: true, info: reply.status === 200 && reply.json && Object.hasOwn(reply.json, nodeType) ? reply.json[nodeType] : null };
  }

  async function missingNodes(server, nodeTypes) {
    const entry = liveEntry(server);
    if (!entry || !Array.isArray(nodeTypes)) return null;
    const answers = await Promise.all(nodeTypes.map((type) => nodeInfo(entry, type)));
    // Any unanswered lookup makes the whole answer unknown: a timeout on a
    // just-started server must not read as "update ComfyUI".
    if (answers.some((answer) => !answer.asked)) return null;
    return nodeTypes.filter((_type, index) => !answers[index].info);
  }

  async function loaderValues(server, nodeType, inputName) {
    const entry = liveEntry(server);
    if (!entry || typeof inputName !== 'string') return null;
    const { info } = await nodeInfo(entry, nodeType);
    const input = info?.input;
    for (const group of [input?.required, input?.optional]) {
      if (!group || typeof group !== 'object' || !Object.hasOwn(group, inputName)) continue;
      const spec = group[inputName];
      const list = Array.isArray(spec?.[0]) ? spec[0] : (spec?.[0] === 'COMBO' ? spec[1]?.options : null);
      if (Array.isArray(list)) return list.filter((value) => typeof value === 'string' && value.length <= 512).slice(0, 5000);
    }
    return null;
  }

  return { start, stop, missingNodes, loaderValues };
}

module.exports = { createComfyProcessOwner, buildLaunchArgs, checkIdentity, RUN_ID };
