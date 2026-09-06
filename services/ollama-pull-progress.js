'use strict';

/**
 * services/ollama-pull-progress.js
 *
 * Pure parser for `ollama pull` stdout, extracted from setup-service.js to keep
 * that file under the file-size ceiling. Translates the CLI's per-layer redraws
 * into a real 0-100 aggregate percent + byte totals.
 *
 * ollama redraws per-layer progress with carriage returns on piped stdio, so
 * callers must split incoming chunks on /\r?\n|\r/ before passing lines here.
 */

// `ollama pull` redraws its per-layer progress in place, emitting VT/ANSI
// control sequences (erase-line \x1b[K, show/hide-cursor \x1b[?25h/l,
// synchronized-output \x1b[?2026h/l, SGR colors, BEL-terminated OSC). Piped
// stdio carries them verbatim, so they must be stripped before a line is shown
// as a human label or scanned for progress tokens. This is the canonical
// `ansi-regex` literal — `strip-ansi` is only a transitive dep, so we inline it
// rather than add a runtime dependency.
// eslint-disable-next-line no-control-regex -- ANSI/VT control bytes are precisely what this strips
const ANSI_PATTERN = /[][[\]()#;?]*(?:(?:(?:(?:;[-a-zA-Z\d/#&.:=?%@~_]+)*|[a-zA-Z\d]+(?:;[-a-zA-Z\d/#&.:=?%@~_]*)*)?)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-ntqry=><~]))/g;

function stripAnsi(value) {
  return String(value ?? '').replace(ANSI_PATTERN, '');
}

const _SIZE_UNITS = { B: 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3, TB: 1024 ** 4 };

function parseSize(num, unit) {
  const value = parseFloat(num);
  if (!Number.isFinite(value)) {
    return 0;
  }
  const mult = _SIZE_UNITS[String(unit || '').toUpperCase()] || 1;
  return Math.round(value * mult);
}

/**
 * Parse one `ollama pull` output line into a structured progress token.
 *
 * Returns null for lines that carry no progress signal. The regexes are
 * intentionally lenient — the exact spacing/byte rendering varies by ollama
 * version and needs runtime validation; unmatched lines degrade to summary-only
 * (the parser never throws).
 */
function parsePullLine(line) {
  const text = stripAnsi(String(line || '')).trim();
  if (!text) {
    return null;
  }
  const lower = text.toLowerCase();
  if (lower.startsWith('pulling manifest')) {
    return { kind: 'status', label: 'Pulling manifest' };
  }
  if (lower.startsWith('verifying')) {
    return { kind: 'status', label: 'Verifying' };
  }
  if (lower.startsWith('writing manifest')) {
    return { kind: 'status', label: 'Writing manifest' };
  }
  if (lower.startsWith('removing')) {
    return { kind: 'status', label: 'Finishing up' };
  }
  if (lower.startsWith('success')) {
    return { kind: 'success', label: 'Complete' };
  }
  if (lower.startsWith('using existing layer')) {
    const reused = text.match(/([0-9a-f]{6,})/);
    return reused
      ? { kind: 'layer', digest: reused[1], percent: 100 }
      : { kind: 'status', label: 'Reusing layers' };
  }
  const pulling = text.match(/pulling\s+([0-9a-f]{6,})/i);
  const pctMatch = text.match(/(\d{1,3})\s*%/);
  if (!pulling && !pctMatch) {
    return null;
  }
  const percent = pctMatch
    ? Math.min(Math.max(parseInt(pctMatch[1], 10), 0), 100)
    : undefined;
  const digest = pulling ? pulling[1] : 'percent-only';
  const ratio = text.match(/(\d+(?:\.\d+)?)\s*([KMGT]?B)\s*\/\s*(\d+(?:\.\d+)?)\s*([KMGT]?B)/i);
  let bytes;
  let total;
  if (ratio) {
    bytes = parseSize(ratio[1], ratio[2]);
    total = parseSize(ratio[3], ratio[4]);
  } else {
    const single = text.match(/(\d+(?:\.\d+)?)\s*([KMGT]?B)\b/i);
    if (single) {
      total = parseSize(single[1], single[2]);
    }
  }
  return { kind: 'layer', digest, percent, bytes, total };
}

/**
 * Single-pass aggregate across all observed layers: size-weighted percent
 * (0-100) plus summed bytes/total. One iteration feeds both the progress bar
 * and the byte counters.
 */
function aggregatePullStats(layers) {
  let weighted = 0;
  let weightTotal = 0;
  let pctSum = 0;
  let count = 0;
  let bytes = 0;
  let totalBytes = 0;
  for (const layer of layers.values()) {
    const pct = Number.isFinite(layer.percent) ? layer.percent : 0;
    pctSum += pct;
    count += 1;
    bytes += layer.bytes || 0;
    totalBytes += layer.total || 0;
    if (layer.total > 0) {
      weighted += layer.total * pct;
      weightTotal += layer.total;
    }
  }
  let percent = 0;
  if (weightTotal > 0) {
    percent = Math.min(Math.round(weighted / weightTotal), 100);
  } else if (count > 0) {
    percent = Math.min(Math.round(pctSum / count), 100);
  }
  return { percent, bytes, totalBytes };
}

module.exports = {
  parseSize,
  parsePullLine,
  aggregatePullStats,
  stripAnsi,
};
