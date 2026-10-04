'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { sanitizeSpawnEnv } = require('./backend/sanitize-spawn-env');
const { readBoundedRegularFile, sameFileSnapshot } = require('./backend/bounded-file-reader');
const { readPngStructure } = require('./backend/png-validator');
const renderPidfile = require('./image-engine-pidfile');
const treeTools = require('./backend/process-tree-tools');

// sd-cli ends each progress update with an erase-line escape (Step 0 fixture
// tests/fixtures/sdcpp/progress-master-929-3f8527a.txt); strip escapes first.
// eslint-disable-next-line no-control-regex -- ANSI CSI sequences.
const ANSI_CSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;

function parseSdCliProgressLine(line) {
  if (typeof line !== 'string' || Buffer.byteLength(line) > 4096) return null;
  const match = line.replace(ANSI_CSI, '').match(/^\s*\|[^|]*\|\s*(\d+)\/(\d+)\s*-\s*(\d+(?:\.\d+)?)(s\/it|it\/s)\s*$/);
  if (!match) return null;
  const step = Number(match[1]);
  const steps = Number(match[2]);
  const rate = Number(match[3]);
  if (!Number.isSafeInteger(step) || !Number.isSafeInteger(steps)
    || steps <= 0 || step > steps || !Number.isFinite(rate) || rate <= 0) return null;
  return { step, steps, secondsPerIt: match[4] === 'it/s' ? 1 / rate : rate };
}

// The phase lines the pinned build prints: three "loading <part> from" lines
// (diffusion model, llm, vae), "generating image: n/m", and the sampling
// summary. Anything else is not a phase change.
function classifyPhaseLine(line) {
  if (typeof line !== 'string' || Buffer.byteLength(line) > 4096) return null;
  const text = line.replace(ANSI_CSI, '');
  if (/^\s*\[INFO\s*\].*loading (?:diffusion model|llm|vae|model) from\s/.test(text)) return { phase: 'load' };
  if (/^\s*\[INFO\s*\].*generating image/.test(text)) return { phase: 'sample' };
  const complete = text.match(/^\s*\[INFO\s*\].*sampling completed, taking (\d+(?:\.\d+)?)s\s*$/);
  if (complete && Number.isFinite(Number(complete[1]))) return { phase: 'sampled', seconds: Number(complete[1]) };
  return null;
}

function isInside(root, target) {
  const relative = path.relative(root, target);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function assertOutputParent(root, outputPath, fsImpl) {
  if (!isInside(root, outputPath)) throw new Error('image_invalid_params');
  let directory = path.dirname(outputPath);
  while (path.relative(root, directory) !== '') {
    if (fsImpl.lstatSync(directory).isSymbolicLink()) throw new Error('image_output_invalid');
    directory = path.dirname(directory);
  }
  const parent = fsImpl.realpathSync(path.dirname(outputPath));
  if (path.relative(root, parent) !== '' && !isInside(root, parent)) throw new Error('image_output_invalid');
}

function validateInputs(options, fsImpl) {
  const { exePath, argv, scratchDir, outputPath, opId, deadlineMs, expectedWidth, expectedHeight, userDataPath } = options;
  const boundedPath = (value) => typeof value === 'string' && value.length <= 1024
    && !value.includes('\0') && path.isAbsolute(value);
  if (!Array.isArray(argv) || !argv.every((arg) => typeof arg === 'string' && arg.length <= 4096 && !arg.includes('\0'))
    || !boundedPath(exePath) || !boundedPath(scratchDir) || !boundedPath(outputPath) || !boundedPath(userDataPath)
    || !/\.png$/i.test(outputPath) || typeof opId !== 'string' || !/^[a-z0-9_-]{8,64}$/.test(opId)
    || !Number.isFinite(deadlineMs) || deadlineMs <= 0
    || !Number.isSafeInteger(expectedWidth) || expectedWidth <= 0
    || !Number.isSafeInteger(expectedHeight) || expectedHeight <= 0) throw new Error('image_invalid_params');
  if (!fsImpl.statSync(scratchDir).isDirectory()) throw new Error('image_invalid_params');
  let outputs = 0;
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '-o') outputs += 1;
    if ((argv[index] === '-o' || argv[index] === '--output') && argv[index + 1] !== outputPath) {
      throw new Error('image_invalid_params');
    }
    if (argv[index].startsWith('--output=') && argv[index].slice(9) !== outputPath) throw new Error('image_invalid_params');
  }
  if (outputs < 1) throw new Error('image_invalid_params');
  const root = fsImpl.realpathSync(scratchDir);
  assertOutputParent(root, outputPath, fsImpl);
  return root;
}

function sanitizeLine(line) {
  // Child output can contain terminal escapes and arbitrary control bytes.
  /* eslint-disable no-control-regex */
  return line.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')
    .replace(/[\x00-\x1f\x7f-\x9f]/g, '')
    .replace(/[A-Za-z]:[\\/][^\s]+|(?<![A-Za-z0-9_])\/[^\s]+/g, '<path>')
    .slice(0, 512);
  /* eslint-enable no-control-regex */
}

function createLineSplitter(onLine, onTruncated) {
  const stored = Buffer.alloc(4096);
  let length = 0;
  let truncated = false;
  const flush = () => {
    if (length) onLine(stored.subarray(0, length).toString('utf8'), truncated);
    length = 0;
    truncated = false;
  };
  const append = (part) => {
    const count = Math.min(part.length, stored.length - length);
    part.copy(stored, length, 0, count);
    length += count;
    if (count < part.length && !truncated) {
      truncated = true;
      onTruncated();
    }
  };
  return {
    push(chunk) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      let start = 0;
      for (let index = 0; index < bytes.length; index += 1) {
        const byte = bytes[index];
        if (byte === 10 || byte === 13) {
          append(bytes.subarray(start, index));
          flush();
          start = index + 1;
        } else if (byte === 0x4b) {
          // An erase-line escape (ESC [ K) ends a progress update; the pinned
          // build glues its next log line straight onto it with no newline.
          append(bytes.subarray(start, index + 1));
          start = index + 1;
          if (length >= 3 && stored[length - 3] === 0x1b && stored[length - 2] === 0x5b) flush();
        }
      }
      append(bytes.subarray(start));
    },
    flush,
  };
}

function readOutput(root, options, fsImpl) {
  const { outputPath, expectedWidth, expectedHeight } = options;
  try {
    assertOutputParent(root, outputPath, fsImpl);
    const stat = fsImpl.lstatSync(outputPath);
    if (stat.isSymbolicLink() || !stat.isFile()) return { reason: 'image_output_invalid', png: null };
    if (!isInside(root, fsImpl.realpathSync(outputPath))) return { reason: 'image_output_invalid', png: null };
    const guardedFs = Object.create(fsImpl);
    guardedFs.fstatSync = (descriptor) => {
      const snapshot = fsImpl.fstatSync(descriptor);
      if (!sameFileSnapshot(stat, snapshot)) throw new Error('image_output_invalid');
      return snapshot;
    };
    const read = readBoundedRegularFile({ fsImpl: guardedFs, filePath: outputPath, maxBytes: 10 * 1024 * 1024 });
    if (!read.ok) return { reason: 'image_output_invalid', png: null };
    // Recheck the path after the bounded descriptor read as well.
    assertOutputParent(root, outputPath, fsImpl);
    const after = fsImpl.lstatSync(outputPath);
    if (after.isSymbolicLink() || !sameFileSnapshot(stat, after)
      || !isInside(root, fsImpl.realpathSync(outputPath))) return { reason: 'image_output_invalid', png: null };
    const structure = readPngStructure(read.buffer);
    if (!structure.ok) return { reason: 'image_output_invalid', png: null };
    if (structure.width !== expectedWidth || structure.height !== expectedHeight) {
      return { reason: 'image_output_mismatch', png: null };
    }
    // The validated bytes travel with the result: the caller publishes them
    // after the chat engine is restored, without re-reading a path that may
    // have changed underneath it meanwhile.
    return { reason: '', png: { width: structure.width, height: structure.height, bytes: read.buffer.length, buffer: read.buffer } };
  } catch (error) {
    return { reason: error?.code === 'ENOENT' ? 'image_output_missing' : 'image_output_invalid', png: null };
  }
}

function runImageGeneration(options = {}) {
  const result = { status: 'failed', exitCode: null, signal: null,
    seconds: { load: null, sample: null, total: 0 }, png: null, stderrTail: [], reason: 'image_invalid_params' };
  let root;
  const fsImpl = options?.fsImpl || fs;
  try { root = validateInputs(options, fsImpl); }
  catch (_error) { return Promise.resolve(result); }
  const { exePath, argv, outputPath, opId, userDataPath, deadlineMs, abortSignal, onProgress,
    spawnImpl = spawn, now = Date.now, sleep } = options;
  const pidfile = { ...renderPidfile, ...options.pidfile };
  const processTools = { ...treeTools, ...options.processTools };
  const emitLog = (level, event, payload = {}) => {
    try { options.log?.(level, `image_engine.${event}`, { opId, ...payload }); }
    catch (_error) { /* Diagnostics cannot interrupt a render. */ }
  };
  const clock = () => {
    try { const time = now(); return Number.isFinite(time) ? time : Date.now(); }
    catch (_error) { return Date.now(); }
  };
  if (abortSignal?.aborted) return Promise.resolve({ ...result, status: 'cancelled', reason: 'image_cancelled' });
  const startedAt = clock();
  let child;
  let pidPath;
  try {
    pidPath = pidfile.getImageEnginePidPath(userDataPath);
    // Refuse a pre-existing link before the native process can write through it.
    try {
      if (fsImpl.lstatSync(outputPath).isSymbolicLink()) {
        return Promise.resolve({ ...result, reason: 'image_output_invalid' });
      }
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    child = spawnImpl(exePath, argv, {
      cwd: path.dirname(exePath), shell: false, detached: false, windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'], env: sanitizeSpawnEnv(process.env),
    });
  } catch (_error) { return Promise.resolve({ ...result, reason: 'image_engine_spawn_failed' }); }

  return new Promise((resolve) => {
    let settling = false;
    let finished = false;
    let recorded = false;
    let exitedAt = null;
    let deadlineTimer;
    let enumerationTimer;
    let enumeration = null;
    let enumerationStarted = false;
    let resolveEnumeration;
    const enumerationPromise = new Promise((done) => { resolveEnumeration = done; });
    let lastProgressAt = -Infinity;
    let loadStarted = null;
    let lastStep = null;
    let truncatedLogged = false;
    let outputClosed = false;
    let resolveOutputClosed;
    const outputClosedPromise = new Promise((done) => { resolveOutputClosed = done; });
    const progress = (event, final = false) => {
      const time = clock();
      if (!final && time - lastProgressAt < 250) return;
      lastProgressAt = time;
      try { onProgress?.(event); } catch (_error) { /* Consumer callbacks are isolated. */ }
    };
    const beginSampling = () => {
      if (loadStarted !== null && result.seconds.load === null) result.seconds.load = Math.max(0, clock() - loadStarted) / 1000;
    };
    const handleLine = (stream, line, truncated) => {
      if (stream === 'stderr') {
        result.stderrTail.push(sanitizeLine(line));
        while (result.stderrTail.length > 20 || Buffer.byteLength(result.stderrTail.join('\n')) > 4096) {
          result.stderrTail.shift();
        }
      }
      if (truncated) return;
      const parsed = parseSdCliProgressLine(line);
      if (parsed) {
        beginSampling();
        lastStep = parsed;
        progress({ phase: 'sample', step: parsed.step, steps: parsed.steps, fraction: parsed.step / parsed.steps });
        return;
      }
      const phase = classifyPhaseLine(line);
      if (phase?.phase === 'load') {
        if (loadStarted === null) loadStarted = clock();
      } else if (phase?.phase === 'sample') {
        beginSampling();
      } else if (phase?.phase === 'sampled') {
        beginSampling();
        result.seconds.sample = phase.seconds;
      }
    };
    const truncated = () => {
      if (truncatedLogged) return;
      truncatedLogged = true;
      emitLog('WARN', 'line_truncated');
    };
    const stdout = createLineSplitter((line, cut) => handleLine('stdout', line, cut), truncated);
    const stderr = createLineSplitter((line, cut) => handleLine('stderr', line, cut), truncated);
    const onStdout = (chunk) => { if (!finished) stdout.push(chunk); };
    const onStderr = (chunk) => { if (!finished) stderr.push(chunk); };
    const enumerate = async () => {
      if (finished || enumerationStarted) return;
      enumerationStarted = true;
      try { enumeration = await processTools.enumerateDescendants(child.pid); }
      catch (_error) { enumeration = { ok: false, pids: [] }; }
      resolveEnumeration(enumeration);
    };
    const removePartial = () => {
      try { assertOutputParent(root, outputPath, fsImpl); fsImpl.unlinkSync(outputPath); }
      catch (_error) { /* Missing output or changed containment is safe to leave alone. */ }
    };
    const finish = () => {
      finished = true;
      clearTimeout(deadlineTimer);
      clearTimeout(enumerationTimer);
      try { abortSignal?.removeEventListener('abort', onAbort); } catch (_error) { /* best effort */ }
      for (const [stream, listener] of [[child.stdout, onStdout], [child.stderr, onStderr]]) {
        try { stream?.removeListener('data', listener); stream?.destroy?.(); } catch (_error) { /* best effort */ }
      }
      emitLog(result.status === 'ok' ? 'INFO' : 'WARN', 'settled', { status: result.status, reason: result.reason });
      resolve(result);
    };
    const settle = async (trigger) => {
      if (settling) return;
      settling = true;
      clearTimeout(deadlineTimer);
      abortSignal?.removeEventListener('abort', onAbort);
      let confirmed;
      try {
        if (trigger === 'exit') {
          const snapshot = await enumerationPromise;
          // A worker started after the early snapshot can outlive a root that
          // exited normally; Windows keeps the dead root as its parent, so a
          // second listing still finds it. Survivors are killed with proof.
          let late = { ok: false, pids: [] };
          try { late = await processTools.enumerateDescendants(child.pid); }
          catch (_error) { /* Unavailable proof is never clean. */ }
          const known = [...new Set([...snapshot.pids, ...late.pids])];
          for (const pid of known) {
            try { await processTools.killTreeWithProof(pid); } catch (_error) { /* Proof below owns the verdict. */ }
          }
          const proof = await processTools.confirmAllGone([child.pid, ...known]);
          confirmed = snapshot.ok === true && late.ok === true && proof.confirmed === true;
          result.status = result.exitCode === 0 && !result.signal ? 'ok' : 'failed';
          result.reason = result.status === 'ok' ? '' : 'image_engine_failed';
        } else {
          clearTimeout(enumerationTimer);
          if (Number.isSafeInteger(child.pid) && child.pid > 0) {
            const proof = await processTools.killTreeWithProof(child.pid);
            confirmed = proof.confirmed === true;
            if (enumerationStarted) {
              const snapshot = await enumerationPromise;
              const known = await processTools.confirmAllGone(snapshot.pids);
              confirmed = confirmed && known.confirmed === true;
            }
          } else confirmed = true;
          const outcomes = {
            abort: ['cancelled', 'image_cancelled'], deadline: ['timeout', 'image_timeout'],
            unrecorded: ['launch_unrecorded', 'image_engine_launch_unrecorded'],
            error: ['failed', 'image_engine_spawn_failed'],
          };
          [result.status, result.reason] = outcomes[trigger];
        }
      } catch (_error) { confirmed = false; }
      if (!confirmed) {
        result.status = 'unconfirmed';
        result.reason = 'image_engine_cleanup_pending';
      }
      if (confirmed) {
        try { if (recorded) pidfile.clearOwnedRenderRecord(pidPath, opId, { fsImpl }); }
        catch (_error) { emitLog('WARN', 'record_clear_failed'); }
        if (trigger !== 'exit') removePartial();
      }
      result.seconds.total = Math.max(0, (exitedAt ?? clock()) - startedAt) / 1000;
      result.recorded = recorded;
      if (!outputClosed && (child.stdout?.readable !== undefined || child.stderr?.readable !== undefined)) {
        let drainTimer;
        await Promise.race([outputClosedPromise,
          new Promise((done) => { drainTimer = setTimeout(done, 250); })]);
        clearTimeout(drainTimer);
      }
      stdout.flush();
      stderr.flush();
      if (trigger === 'exit' && result.exitCode === 0 && !result.signal && confirmed) {
        progress({ phase: 'sample', step: lastStep?.steps ?? null, steps: lastStep?.steps ?? null, fraction: 1 }, true);
        const output = readOutput(root, options, fsImpl);
        result.png = output.png;
        result.reason = output.reason;
        if (!output.png) result.status = 'failed';
      }
      finish();
    };
    const requestSettlement = (trigger) => {
      settle(trigger).catch(() => {
        result.status = 'unconfirmed';
        result.reason = 'image_engine_cleanup_pending';
        finish();
      });
    };
    const onAbort = () => { requestSettlement('abort'); };
    child.on('exit', (code, signal) => {
      if (finished) return;
      exitedAt = clock();
      result.exitCode = code;
      result.signal = signal || null;
      requestSettlement('exit');
    });
    child.on('error', () => { requestSettlement('error'); });
    child.on('close', () => { outputClosed = true; resolveOutputClosed(); });
    child.stdout?.on('data', onStdout);
    child.stderr?.on('data', onStderr);
    if (!Number.isSafeInteger(child.pid) || child.pid <= 0) return;
    try {
      pidfile.writeRenderRecord(pidPath, { pid: child.pid, exePath, opId, output: outputPath, startedAt }, { fsImpl });
      recorded = true;
    } catch (_error) { requestSettlement('unrecorded'); return; }
    emitLog('INFO', 'spawned', { exe: path.basename(exePath), pid: child.pid });
    if (sleep) {
      Promise.resolve().then(() => sleep(500)).then(enumerate, () => {
        enumeration = { ok: false, pids: [] };
        resolveEnumeration(enumeration);
      });
    } else enumerationTimer = setTimeout(() => { void enumerate(); }, 500);
    const scheduleDeadline = () => {
      const remaining = Math.max(0, deadlineMs - (clock() - startedAt));
      deadlineTimer = setTimeout(() => {
        if (remaining > 2147483647) scheduleDeadline();
        else requestSettlement('deadline');
      }, Math.min(remaining, 2147483647));
    };
    scheduleDeadline();
    abortSignal?.addEventListener('abort', onAbort, { once: true });
    if (abortSignal?.aborted) onAbort();
  }).catch(async () => {
    let confirmed = false;
    try { confirmed = (await processTools.killTreeWithProof(child.pid)).confirmed === true; }
    catch (_error) { /* Retain cleanup uncertainty. */ }
    return { ...result, status: confirmed ? 'failed' : 'unconfirmed',
      reason: confirmed ? 'image_engine_failed' : 'image_engine_cleanup_pending' };
  });
}

module.exports = { parseSdCliProgressLine, classifyPhaseLine, createLineSplitter, runImageGeneration };
