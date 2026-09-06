'use strict';

const fs = require('fs');
const path = require('path');
const { normalizeText: normalizeString } = require('../shared/normalize');

const DEFAULT_RECENT_TRACE_LIMIT = 10;
const MAX_RECENT_TRACE_LIMIT = 25;
const MAX_DIAGNOSTIC_FILES_SCANNED = 250;
const DIAGNOSTIC_DATE_SEGMENT_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const PROVIDER_TIMING_FIELDS = [
  'time_to_provider_request_start_ms',
  'time_to_first_chunk_ms',
  'time_to_first_visible_token_ms',
  'visible_tokens_per_second_estimate',
  'context_tokens_estimate',
  'provider_message_count',
  'provider_tool_count',
  'provider_tool_payload_bytes',
  'request_duration_ms',
  'response_duration_ms',
  'total_duration_ms',
];

function normalizeLimit(value, fallback = DEFAULT_RECENT_TRACE_LIMIT) {
  const numeric = Number(value);
  if (!Number.isInteger(numeric) || numeric <= 0) {
    return fallback;
  }
  return Math.min(numeric, MAX_RECENT_TRACE_LIMIT);
}

function normalizeNonNegativeNumber(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 0 ? numeric : null;
}

function normalizeIso(value) {
  const text = normalizeString(value);
  if (!text) {
    return '';
  }
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : '';
}

function diagnosticRoot(userDataPath) {
  const root = normalizeString(userDataPath);
  return root ? path.join(root, 'diagnostics') : '';
}

function buildDiagnosticRef(dateSegment, streamId) {
  return {
    kind: 'turn_diagnostic',
    date: dateSegment,
    stream_id: streamId,
    relative_path: ['diagnostics', dateSegment, `${streamId}.json`].join('/'),
  };
}

async function safeReadDir(dirPath) {
  try {
    return await fs.promises.readdir(dirPath, { withFileTypes: true });
  } catch (_error) {
    return null;
  }
}

async function collectDiagnosticCandidates(root) {
  const dateEntries = await safeReadDir(root);
  if (!dateEntries) {
    return { rootAvailable: false, candidates: [] };
  }
  const candidates = [];
  const dateDirs = dateEntries
    .filter((entry) => entry.isDirectory() && DIAGNOSTIC_DATE_SEGMENT_PATTERN.test(entry.name))
    .map((entry) => entry.name)
    .sort()
    .reverse();

  for (const dateSegment of dateDirs) {
    if (candidates.length >= MAX_DIAGNOSTIC_FILES_SCANNED) {
      break;
    }
    const dirPath = path.join(root, dateSegment);
    const fileEntries = await safeReadDir(dirPath);
    if (!fileEntries) {
      continue;
    }
    const dayCandidates = [];
    for (const entry of fileEntries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) {
        continue;
      }
      const streamId = normalizeString(path.basename(entry.name, '.json'));
      if (!streamId) {
        continue;
      }
      const filePath = path.join(dirPath, entry.name);
      let mtimeMs;
      try {
        const stat = await fs.promises.stat(filePath);
        mtimeMs = Number(stat.mtimeMs || 0);
      } catch (_error) {
        continue;
      }
      dayCandidates.push({ dateSegment, filePath, mtimeMs, streamId });
    }
    dayCandidates.sort((left, right) => (
      Number(right.mtimeMs || 0) - Number(left.mtimeMs || 0)
      || left.streamId.localeCompare(right.streamId)
    ));
    const remaining = MAX_DIAGNOSTIC_FILES_SCANNED - candidates.length;
    candidates.push(...dayCandidates.slice(0, remaining));
  }
  candidates.sort((left, right) => {
    if (left.dateSegment !== right.dateSegment) {
      return right.dateSegment.localeCompare(left.dateSegment);
    }
    return Number(right.mtimeMs || 0) - Number(left.mtimeMs || 0);
  });
  return {
    rootAvailable: true,
    candidates: candidates.slice(0, MAX_DIAGNOSTIC_FILES_SCANNED),
  };
}

function normalizeTimingMarkers(markers) {
  if (!Array.isArray(markers) || markers.length === 0) {
    return [];
  }
  const rows = [];
  for (const [index, marker] of markers.entries()) {
    if (!marker || typeof marker !== 'object' || Array.isArray(marker)) {
      continue;
    }
    const name = normalizeString(marker.name);
    if (!name) {
      continue;
    }
    const explicitRelative = normalizeNonNegativeNumber(marker.relative_ms);
    const tsMs = normalizeNonNegativeNumber(marker.ts_ms);
    rows.push({
      name,
      index,
      relativeMs: explicitRelative,
      tsMs,
    });
  }
  if (rows.length === 0) {
    return [];
  }
  rows.sort((left, right) => {
    const leftSort = left.tsMs ?? left.relativeMs;
    const rightSort = right.tsMs ?? right.relativeMs;
    if (leftSort != null && rightSort != null && leftSort !== rightSort) {
      return leftSort - rightSort;
    }
    return left.index - right.index;
  });
  const baseTs = rows.find((row) => row.tsMs != null)?.tsMs ?? null;
  return rows.map((row) => {
    const relativeMs = row.relativeMs != null
      ? row.relativeMs
      : (baseTs != null && row.tsMs != null ? Math.max(row.tsMs - baseTs, 0) : 0);
    return {
      name: row.name,
      relative_ms: relativeMs,
    };
  });
}

function buildTimingSpans(timingMarkers) {
  const spans = [];
  for (let index = 1; index < timingMarkers.length; index += 1) {
    const previous = timingMarkers[index - 1];
    const current = timingMarkers[index];
    spans.push({
      from: previous.name,
      to: current.name,
      duration_ms: Math.max(current.relative_ms - previous.relative_ms, 0),
    });
  }
  return spans;
}

function normalizeProviderTiming(providerDiagnostics) {
  if (
    !providerDiagnostics
    || typeof providerDiagnostics !== 'object'
    || Array.isArray(providerDiagnostics)
  ) {
    return {};
  }
  const timing = {};
  for (const field of PROVIDER_TIMING_FIELDS) {
    const value = normalizeNonNegativeNumber(providerDiagnostics[field]);
    if (value != null) {
      timing[field] = value;
    }
  }
  return timing;
}

function normalizeToolEventSummary(toolEvents) {
  if (!Array.isArray(toolEvents) || toolEvents.length === 0) {
    return {
      total: 0,
      by_phase: {},
      tool_names: [],
    };
  }
  const byPhase = {};
  const toolNames = new Set();
  let total = 0;
  for (const event of toolEvents) {
    if (!event || typeof event !== 'object' || Array.isArray(event)) {
      continue;
    }
    total += 1;
    const phase = normalizeString(event.phase);
    const name = normalizeString(event.name || event.tool_name || event.toolName);
    if (phase) {
      byPhase[phase] = (byPhase[phase] || 0) + 1;
    }
    if (name) {
      toolNames.add(name);
    }
  }
  return {
    total,
    by_phase: byPhase,
    tool_names: Array.from(toolNames).sort().slice(0, 20),
  };
}

function normalizeDiagnosticPayload(payload, candidate) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return null;
  }
  const streamId = normalizeString(payload.stream_id || payload.streamId || candidate.streamId);
  if (!streamId) {
    return null;
  }
  const timingMarkers = normalizeTimingMarkers(payload.timing_markers || payload.timingMarkers);
  const durationMs = timingMarkers.reduce(
    (max, marker) => Math.max(max, normalizeNonNegativeNumber(marker.relative_ms) ?? 0),
    0
  );
  const writtenAt = normalizeIso(payload.written_at || payload.writtenAt);
  const sortMs = writtenAt ? Date.parse(writtenAt) : Number(candidate.mtimeMs || 0);
  return {
    sortMs: Number.isFinite(sortMs) ? sortMs : 0,
    entry: {
      written_at: writtenAt,
      diagnostic_ref: buildDiagnosticRef(candidate.dateSegment, streamId),
      session_id: normalizeString(payload.session_id || payload.sessionId),
      stream_id: streamId,
      request_id: normalizeString(payload.request_id || payload.requestId),
      trace_id: normalizeString(payload.trace_id || payload.traceId),
      terminal_status: normalizeString(payload.terminal_status || payload.terminalStatus),
      engine_type: normalizeString(payload.engine_type || payload.engineType),
      model: normalizeString(payload.model),
      mode: normalizeString(payload.mode),
      duration_ms: durationMs,
      timing_markers: timingMarkers,
      timing_spans: buildTimingSpans(timingMarkers),
      provider_timing: normalizeProviderTiming(
        payload.provider_diagnostics || payload.providerDiagnostics
      ),
      tool_events: normalizeToolEventSummary(payload.tool_events || payload.toolEvents),
    },
  };
}

async function readDiagnostic(candidate) {
  const text = await fs.promises.readFile(candidate.filePath, 'utf8');
  return normalizeDiagnosticPayload(JSON.parse(text), candidate);
}

async function buildTurnDiagnosticIndex({
  userDataPath,
  sessionId,
  limit,
} = {}) {
  const recentLimit = normalizeLimit(limit);
  const root = diagnosticRoot(userDataPath);
  const retention = {
    recent_limit: recentLimit,
    max_recent_limit: MAX_RECENT_TRACE_LIMIT,
    max_files_scanned: MAX_DIAGNOSTIC_FILES_SCANNED,
  };
  if (!root) {
    return {
      available: false,
      error: 'User data path is unavailable.',
      count: 0,
      skipped_count: 0,
      diagnostics_root_available: false,
      retention,
      recent: [],
    };
  }

  const { rootAvailable, candidates } = await collectDiagnosticCandidates(root);
  if (!rootAvailable) {
    return {
      available: true,
      count: 0,
      skipped_count: 0,
      diagnostics_root_available: false,
      retention,
      recent: [],
    };
  }

  const requestedSessionId = normalizeString(sessionId);
  const rows = [];
  let skippedCount = 0;
  for (const candidate of candidates) {
    try {
      const normalized = await readDiagnostic(candidate);
      if (!normalized) {
        skippedCount += 1;
        continue;
      }
      if (requestedSessionId && normalized.entry.session_id !== requestedSessionId) {
        continue;
      }
      rows.push(normalized);
    } catch (_error) {
      skippedCount += 1;
    }
  }
  rows.sort((left, right) => right.sortMs - left.sortMs);
  const recent = rows.slice(0, recentLimit).map((row) => row.entry);
  return {
    available: true,
    count: recent.length,
    skipped_count: skippedCount,
    diagnostics_root_available: true,
    retention,
    recent,
  };
}

module.exports = {
  buildTurnDiagnosticIndex,
  DEFAULT_RECENT_TRACE_LIMIT,
  MAX_RECENT_TRACE_LIMIT,
  MAX_DIAGNOSTIC_FILES_SCANNED,
};
