const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { ensureDir } = require('./path-utils');
const { HARNESS_ERROR_CODES } = require('./error-codes');
const { redactLogValue } = require('../log-entry-normalizer');
const {
  CLIENT_TIMING_PENDING_LIMIT,
  CLIENT_TIMING_PENDING_TTL_MS,
  storePendingClientTiming: _storePendingClientTiming,
  takePendingClientTiming: _takePendingClientTiming,
  normalizeClientTiming: _normalizeClientTiming,
} = require('./turn-diagnostic-client-timing');

const TURN_DIAGNOSTIC_SCHEMA_VERSION = 1;
const HARNESS_TURN_NOT_FOUND_CODE = HARNESS_ERROR_CODES.TURN_NOT_FOUND;
const DEFAULT_DIAGNOSTIC_MAX_AGE_DAYS = 30;
const DEFAULT_DIAGNOSTIC_MAX_FILES = 5000;
const MS_PER_DAY = 24 * 60 * 60 * 1000;
function _dateSegmentForNow() {
  const now = new Date();
  const yyyy = String(now.getUTCFullYear()).padStart(4, '0');
  const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(now.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function _normalizeTimingMarkers(markers) {
  if (!Array.isArray(markers) || markers.length === 0) {
    return [];
  }
  const normalized = [];
  for (const entry of markers) {
    if (!entry || typeof entry !== 'object') continue;
    const name = String(entry.name || '').trim();
    const tsMs = Number(entry.ts_ms);
    if (!name || !Number.isFinite(tsMs)) continue;
    normalized.push({ name, ts_ms: tsMs });
  }
  if (normalized.length === 0) return [];
  normalized.sort((a, b) => a.ts_ms - b.ts_ms);
  const base = normalized[0].ts_ms;
  return normalized.map((entry) => ({
    name: entry.name,
    ts_ms: entry.ts_ms,
    relative_ms: Math.max(entry.ts_ms - base, 0),
  }));
}

function _normalizeContextAssemblyBreakdown(breakdown) {
  if (!breakdown || typeof breakdown !== 'object') return null;
  const out = {};
  const msFields = [
    'parallelElapsedMs',
    'personalityMs',
    'memoryMs',
    'memoryRecallMs',
    'memoryRecentMs',
    'gitMs',
  ];
  for (const key of msFields) {
    const value = Number(breakdown[key]);
    if (Number.isFinite(value)) {
      out[key] = Math.max(value, 0);
    }
  }
  const boolFields = [
    'includedPersonality',
    'includedMemory',
    'includedGitContext',
  ];
  for (const key of boolFields) {
    if (typeof breakdown[key] === 'boolean') {
      out[key] = breakdown[key];
    }
  }
  return Object.keys(out).length === 0 ? null : out;
}

function _normalizeTerminalError(terminalError) {
  if (!terminalError || typeof terminalError !== 'object') return null;
  const out = {};
  if (terminalError.code != null) out.code = String(terminalError.code);
  if (terminalError.message != null) out.message = String(terminalError.message);
  if (typeof terminalError.retryable === 'boolean') out.retryable = terminalError.retryable;
  if (terminalError.category != null) out.category = String(terminalError.category);
  if (terminalError.cancel_reason != null) {
    out.cancel_reason = String(terminalError.cancel_reason);
  }
  if (terminalError.terminal_subcode != null) {
    out.terminal_subcode = String(terminalError.terminal_subcode);
  }
  if (terminalError.error_type != null) {
    out.error_type = String(terminalError.error_type).slice(0, 200);
  }
  if (terminalError.error_message != null) {
    out.error_message = String(terminalError.error_message).slice(0, 500);
  }
  return Object.keys(out).length === 0 ? null : out;
}

function _normalizeToolEvents(events) {
  if (!Array.isArray(events) || events.length === 0) return [];
  const out = [];
  for (const entry of events) {
    if (!entry || typeof entry !== 'object') continue;
    const callId = String(entry.call_id || entry.callId || '').trim();
    const name = String(entry.name || '').trim();
    const phase = String(entry.phase || '').trim();
    const tsMs = Number(entry.ts_ms != null ? entry.ts_ms : entry.tsMs);
    if (!callId || !name || !phase || !Number.isFinite(tsMs)) continue;
    out.push({ call_id: callId, name, phase, ts_ms: tsMs });
  }
  return out;
}

function _trimmedOrNull(value) {
  const normalized = String(value == null ? '' : value).trim();
  return normalized || null;
}

function _diagnosticsRoot(userDataPath) {
  return path.join(userDataPath, 'diagnostics');
}

function _dateFromSegment(segment) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(segment || ''));
  if (!match) {
    return null;
  }
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return Number.isNaN(date.getTime()) ? null : date;
}

async function _safeRm(targetPath) {
  await fs.promises.rm(targetPath, { recursive: true, force: true });
  return 1;
}

async function _writeFileAtomic(filePath, content) {
  const tempPath = `${filePath}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  try {
    await fs.promises.writeFile(tempPath, content, 'utf8');
    await fs.promises.rename(tempPath, filePath);
  } catch (error) {
    await fs.promises.rm(tempPath, { force: true }).catch(() => null);
    throw error;
  }
}

async function _collectDiagnosticFiles(root) {
  const files = [];
  let entries;
  try {
    entries = await fs.promises.readdir(root, { withFileTypes: true });
  } catch {
    return files;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const dir = path.join(root, entry.name);
    let children;
    try {
      children = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const child of children) {
      if (!child.isFile() || !child.name.endsWith('.json')) {
        continue;
      }
      const filePath = path.join(dir, child.name);
      try {
        const stat = await fs.promises.stat(filePath);
        files.push({ filePath, mtimeMs: stat.mtimeMs });
      } catch {
        // File disappeared during sweep.
      }
    }
  }
  return files;
}

async function pruneTurnDiagnostics({
  userDataPath,
  now = new Date(),
  maxAgeDays = DEFAULT_DIAGNOSTIC_MAX_AGE_DAYS,
  maxFiles = DEFAULT_DIAGNOSTIC_MAX_FILES,
} = {}) {
  const root = _trimmedOrNull(userDataPath) ? _diagnosticsRoot(userDataPath) : null;
  if (!root) {
    return { removedCount: 0 };
  }
  let removedCount = 0;
  const cutoffMs = now.getTime() - Math.max(Number(maxAgeDays) || DEFAULT_DIAGNOSTIC_MAX_AGE_DAYS, 1) * MS_PER_DAY;
  let entries;
  try {
    entries = await fs.promises.readdir(root, { withFileTypes: true });
  } catch {
    return { removedCount: 0 };
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const date = _dateFromSegment(entry.name);
    if (!date || date.getTime() + MS_PER_DAY > cutoffMs) {
      continue;
    }
    removedCount += await _safeRm(path.join(root, entry.name));
  }

  const files = await _collectDiagnosticFiles(root);
  const cap = Math.max(Number(maxFiles) || DEFAULT_DIAGNOSTIC_MAX_FILES, 1);
  if (files.length > cap) {
    files.sort((a, b) => a.mtimeMs - b.mtimeMs);
    for (const entry of files.slice(0, files.length - cap)) {
      removedCount += await _safeRm(entry.filePath);
    }
  }
  return { removedCount };
}

async function _fetchSidecarSnapshot(emitLog, service, requestId) {
  if (!service || !service.sidecarClient) return null;
  const fn = service.sidecarClient.harnessTurnDiagnostic;
  if (typeof fn !== 'function') return null;
  try {
    const response = await fn.call(service.sidecarClient, { request_id: requestId });
    if (response && typeof response === 'object' && response.provider_diagnostics) {
      return response.provider_diagnostics;
    }
    return null;
  } catch (error) {
    const errorCode = String(error?.error_code || error?.data?.error_code || '').trim();
    if (errorCode === HARNESS_TURN_NOT_FOUND_CODE) {
      return null;
    }
    emitLog('WARN', 'chat.turn_diagnostic_sidecar_fetch_failed', {
      requestId,
      message: String(error?.message || error),
      errorCode: errorCode || null,
    });
    return null;
  }
}

async function fetchTurnProviderDiagnostics({ service, requestId } = {}) {
  const emitLog = (level, event, details) => {
    if (typeof service?._emitServiceLog === 'function') {
      service._emitServiceLog(level, event, details);
    }
  };
  return _fetchSidecarSnapshot(emitLog, service, requestId);
}

async function dumpTurnDiagnostic({
  service,
  sessionId,
  streamId,
  requestId,
  traceId,
  terminalStatus,
  timingMarkers,
  contextContributions,
  toolEvents,
  terminalError,
  engineType,
  model,
  mode,
  counts,
  clientTiming,
  contextAssemblyBreakdown,
  redactionPrefixes,
}) {
  const resolvedRequestId = _trimmedOrNull(requestId) || _trimmedOrNull(streamId);
  const resolvedStreamId = _trimmedOrNull(streamId) || _trimmedOrNull(requestId);
  if (!resolvedStreamId) {
    return null;
  }
  if (!/^[A-Za-z0-9._-]+$/.test(resolvedStreamId)) {
    service?._emitServiceLog?.('WARN', 'chat.turn_diagnostic_stream_id_rejected', {
      streamId: String(resolvedStreamId).slice(0, 100),
    });
    return null;
  }
  const userDataPath = _trimmedOrNull(service?.options?.userDataPath);
  if (!userDataPath) {
    return null;
  }

  const emitLog = (level, event, details) => {
    if (typeof service?._emitServiceLog === 'function') {
      service._emitServiceLog(level, event, details);
    }
  };

  const providerDiagnostics = await fetchTurnProviderDiagnostics({
    service,
    requestId: resolvedRequestId,
  });

  const payload = {
    schema_version: TURN_DIAGNOSTIC_SCHEMA_VERSION,
    written_at: new Date().toISOString(),
    request_id: resolvedRequestId,
    stream_id: resolvedStreamId,
    session_id: _trimmedOrNull(sessionId),
    trace_id: _trimmedOrNull(traceId),
    terminal_status: _trimmedOrNull(terminalStatus),
    engine_type: _trimmedOrNull(engineType),
    model: _trimmedOrNull(model),
    mode: _trimmedOrNull(mode),
    timing_markers: _normalizeTimingMarkers(timingMarkers),
    provider_diagnostics: providerDiagnostics,
    context_contributions: (contextContributions && typeof contextContributions === 'object')
      ? contextContributions
      : null,
    context_assembly_breakdown: _normalizeContextAssemblyBreakdown(contextAssemblyBreakdown),
    tool_events: _normalizeToolEvents(toolEvents),
    terminal_error: _normalizeTerminalError(terminalError),
    counts: (counts && typeof counts === 'object') ? counts : null,
    client_timing: _normalizeClientTiming(clientTiming),
  };
  const redactedPayload = redactLogValue(payload, {
    prefixes: [
      userDataPath,
      ...(Array.isArray(redactionPrefixes) ? redactionPrefixes : []),
    ].filter(Boolean),
  });

  const dateSegment = _dateSegmentForNow();
  const dir = path.join(userDataPath, 'diagnostics', dateSegment);
  const filePath = path.join(dir, `${resolvedStreamId}.json`);

  try {
    const sweep = await pruneTurnDiagnostics({ userDataPath });
    if (sweep.removedCount > 0) {
      emitLog('INFO', 'logs.turn_diagnostic_swept', {
        removedCount: sweep.removedCount,
      });
    }
  } catch (error) {
    emitLog('WARN', 'chat.turn_diagnostic_sweep_failed', {
      message: String(error?.message || error),
    });
  }

  let pendingTiming = null;
  try {
    ensureDir(dir);
    pendingTiming = _takePendingClientTiming(emitLog, userDataPath, resolvedStreamId);
    if (pendingTiming) {
      redactedPayload.client_timing = {
        ...(redactedPayload.client_timing || {}),
        ...pendingTiming,
      };
    }
    await _writeFileAtomic(filePath, `${JSON.stringify(redactedPayload, null, 2)}\n`);
    if (pendingTiming) {
      emitLog('INFO', 'chat.turn_diagnostic_client_timing_merged', {
        streamId: resolvedStreamId,
        path: filePath,
        source: 'pending',
      });
    }
  } catch (error) {
    if (pendingTiming) {
      _storePendingClientTiming(
        emitLog,
        userDataPath,
        resolvedStreamId,
        pendingTiming,
        { preferExisting: true }
      );
    }
    emitLog('WARN', 'chat.turn_diagnostic_dump_failed', {
      sessionId: redactedPayload.session_id,
      streamId: resolvedStreamId,
      traceId: redactedPayload.trace_id,
      path: filePath,
      terminalStatus: redactedPayload.terminal_status,
      message: String(error?.message || error),
    });
    return null;
  }

  emitLog('INFO', 'chat.turn_diagnostic_dumped', {
    sessionId: redactedPayload.session_id,
    streamId: resolvedStreamId,
    traceId: redactedPayload.trace_id,
    path: filePath,
    terminalStatus: redactedPayload.terminal_status,
  });

  return filePath;
}

async function _findTurnDiagnosticFile(userDataPath, streamId) {
  const todayPath = path.join(_diagnosticsRoot(userDataPath), _dateSegmentForNow(), `${streamId}.json`);
  try {
    await fs.promises.access(todayPath);
    return todayPath;
  } catch {
    // Fall through to the date-dir scan (clock rolled past midnight between
    // the dump and the renderer's terminal report).
  }
  let entries;
  try {
    entries = await fs.promises.readdir(_diagnosticsRoot(userDataPath), { withFileTypes: true });
  } catch {
    return null;
  }
  const dateDirs = entries
    .filter((entry) => entry.isDirectory() && _dateFromSegment(entry.name))
    .map((entry) => entry.name)
    .sort()
    .reverse();
  for (const segment of dateDirs) {
    const candidate = path.join(_diagnosticsRoot(userDataPath), segment, `${streamId}.json`);
    try {
      await fs.promises.access(candidate);
      return candidate;
    } catch {
      // Keep scanning older days.
    }
  }
  return null;
}

// Merges renderer-side paint counters into an already-dumped turn diagnostic.
// The dump is written while the main process handles the terminal event; the
// renderer reports its counters slightly later, so this retries briefly for
// the file to appear before giving up with a WARN.
async function mergeClientTimingIntoTurnDiagnostic({
  service,
  streamId,
  clientTiming,
  attempts = 6,
  delayMs = 250,
} = {}) {
  const resolvedStreamId = _trimmedOrNull(streamId);
  const userDataPath = _trimmedOrNull(service?.options?.userDataPath);
  const normalizedTiming = _normalizeClientTiming(clientTiming);
  if (!resolvedStreamId || !userDataPath || !normalizedTiming) {
    return null;
  }
  // streamIds are caller-supplied over IPC; reject anything that could
  // escape the diagnostics directory before it reaches a path join.
  if (!/^[A-Za-z0-9._-]+$/.test(resolvedStreamId)) {
    return null;
  }
  const emitLog = (level, event, details) => {
    if (typeof service?._emitServiceLog === 'function') {
      service._emitServiceLog(level, event, details);
    }
  };

  let filePath = null;
  for (let attempt = 0; attempt < Math.max(attempts, 1); attempt += 1) {
    filePath = await _findTurnDiagnosticFile(userDataPath, resolvedStreamId);
    if (filePath) break;
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  if (!filePath) {
    _storePendingClientTiming(emitLog, userDataPath, resolvedStreamId, normalizedTiming);
    emitLog('INFO', 'chat.turn_diagnostic_client_timing_pending', {
      streamId: resolvedStreamId,
      message: 'Renderer stream metrics are waiting for the turn diagnostic dump.',
    });
    return null;
  }

  try {
    const payload = JSON.parse(await fs.promises.readFile(filePath, 'utf8'));
    payload.client_timing = {
      ...(payload.client_timing && typeof payload.client_timing === 'object' ? payload.client_timing : {}),
      ...normalizedTiming,
    };
    await _writeFileAtomic(filePath, `${JSON.stringify(payload, null, 2)}\n`);
    emitLog('INFO', 'chat.turn_diagnostic_client_timing_merged', {
      streamId: resolvedStreamId,
      path: filePath,
    });
    return filePath;
  } catch (error) {
    _storePendingClientTiming(emitLog, userDataPath, resolvedStreamId, normalizedTiming);
    emitLog('WARN', 'chat.turn_diagnostic_client_timing_merge_failed', {
      streamId: resolvedStreamId,
      path: filePath,
      message: String(error?.message || error),
    });
    return null;
  }
}

module.exports = {
  dumpTurnDiagnostic,
  fetchTurnProviderDiagnostics,
  mergeClientTimingIntoTurnDiagnostic,
  pruneTurnDiagnostics,
  TURN_DIAGNOSTIC_SCHEMA_VERSION,
  CLIENT_TIMING_PENDING_LIMIT,
  CLIENT_TIMING_PENDING_TTL_MS,
};
