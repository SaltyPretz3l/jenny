'use strict';

// Encoder for the demo clip recorder (scripts/demo/record-demo-clips.js).
//
// Reads artifacts/demo/<name>.webm + <name>.meta.json, refuses recordings that
// look frozen (an occluded window can stop producing compositor frames), then
// writes docs/media/<name>.gif (two-pass palette, Bayer dither) and <name>.mp4.
// The GIF walks a fixed size ladder (fps, then width, then colors) until it is
// under budget. Argument builders and the frozen-frame assessment are pure and
// covered by tests/demo-encode-args.test.js; only main() touches ffmpeg.

const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_ENCODE = Object.freeze({ fps: 15, width: 1280, maxColors: 192, sizeBudgetBytes: 6 * 1024 * 1024 });
const LADDER = Object.freeze([
  { fps: 12 },
  { fps: 10 },
  { width: 1120 },
  { width: 960 },
  { maxColors: 128 },
  { maxColors: 96 },
]);
const MAX_BUFFER_BYTES = 64 * 1024 * 1024;
// A capture whose picture stops changing this long before the end is frozen.
const FROZEN_TAIL_SECONDS = 3.5;

function roundToMillis(value) {
  return Math.round(value * 1000) / 1000;
}
function nextLadderStep(settings, index) {
  if (index >= LADDER.length) {
    return null;
  }
  return {
    settings: Object.assign({}, settings, LADDER[index]),
    index: index + 1,
  };
}

function trimWindow(meta) {
  const startSeconds = roundToMillis(Number(meta.leadInMs) / 1000);
  const recordedMs = meta.recordedMs;
  const endSeconds = typeof recordedMs === 'number' && Number.isFinite(recordedMs)
    ? roundToMillis(recordedMs / 1000)
    : null;
  return { startSeconds, endSeconds };
}
// Fade in from black at the start and out at the end so the loop seam reads
// as a cut instead of a jump. The fade-out needs the padded clip length, so
// it is skipped when the recording length is unknown.
const FADE_IN_SECONDS = 0.3;
const FADE_OUT_SECONDS = 0.45;
function fadeFilter(meta) {
  const { startSeconds, endSeconds } = trimWindow(meta);
  const tailSeconds = roundToMillis(Number(meta.tailHoldMs) / 1000);
  const parts = [`fade=t=in:st=0:d=${FADE_IN_SECONDS}`];
  if (endSeconds !== null) {
    const paddedSeconds = roundToMillis(endSeconds - startSeconds + tailSeconds);
    parts.push(`fade=t=out:st=${roundToMillis(paddedSeconds - FADE_OUT_SECONDS)}:d=${FADE_OUT_SECONDS}`);
  }
  return parts.join(',');
}
function videoFilter(settings, meta) {
  const tailSeconds = roundToMillis(Number(meta.tailHoldMs) / 1000);
  return `fps=${settings.fps},scale=${settings.width}:-2:flags=lanczos,`
    + `tpad=stop_mode=clone:stop_duration=${tailSeconds},${fadeFilter(meta)}`;
}
function trimArgs(meta) {
  const { startSeconds, endSeconds } = trimWindow(meta);
  const args = ['-ss', String(startSeconds)];
  if (endSeconds !== null) {
    args.push('-to', String(endSeconds));
  }
  return args;
}
function buildGifPaletteArgs({ input, palettePath, settings, meta }) {
  return [
    '-y',
    ...trimArgs(meta),
    '-i', input,
    '-vf', `${videoFilter(settings, meta)},`
      + `palettegen=max_colors=${settings.maxColors}:stats_mode=diff`,
    palettePath,
  ];
}
function buildGifEncodeArgs({ input, palettePath, output, settings, meta }) {
  return [
    '-y',
    ...trimArgs(meta),
    '-i', input,
    '-i', palettePath,
    '-lavfi', `${videoFilter(settings, meta)}[x];`
      + '[x][1:v]paletteuse=dither=bayer:bayer_scale=3:diff_mode=rectangle',
    '-loop', '0',
    output,
  ];
}
function buildMp4Args({ input, output, settings, meta }) {
  const tailSeconds = roundToMillis(Number(meta.tailHoldMs) / 1000);
  return [
    '-y',
    ...trimArgs(meta),
    '-i', input,
    '-vf', `scale=${settings.width}:-2:flags=lanczos,`
      + `tpad=stop_mode=clone:stop_duration=${tailSeconds},${fadeFilter(meta)},format=yuv420p`,
    '-c:v', 'libx264',
    '-preset', 'slow',
    '-crf', '23',
    '-movflags', '+faststart',
    '-an',
    output,
  ];
}
function buildFrameProbeArgs(input) {
  return [
    '-v', 'error', '-count_frames', '-select_streams', 'v:0',
    '-show_entries', 'stream=nb_read_frames,r_frame_rate,duration', '-of', 'json', input,
  ];
}
function buildDecimateArgs(input) {
  return ['-i', input, '-vf', 'mpdecimate', '-loglevel', 'debug', '-f', 'null', '-'];
}

function finiteNumber(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function parseFrameRate(value) {
  if (typeof value !== 'string') {
    return finiteNumber(value);
  }
  const [numeratorText, denominatorText] = value.split('/');
  const numerator = finiteNumber(numeratorText);
  const denominator = denominatorText === undefined ? 1 : finiteNumber(denominatorText);
  if (numerator === null || denominator === null || denominator === 0) {
    return null;
  }
  return numerator / denominator;
}

function parseFrameProbe(jsonText) {
  let parsed;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    parsed = null;
  }
  const stream = parsed && Array.isArray(parsed.streams) ? parsed.streams[0] : null;
  return {
    frames: stream ? finiteNumber(stream.nb_read_frames) : null,
    fps: stream ? parseFrameRate(stream.r_frame_rate) : null,
    durationSeconds: stream ? finiteNumber(stream.duration) : null,
  };
}

// mpdecimate's debug log has one `keep pts:<n> pts_time:<s>` / `drop pts:...`
// line per frame. A static UI legitimately drops most frames, so the signal
// for a frozen window is "too few kept frames" plus "the last kept frame sits
// well before the end", not the kept ratio.
function countDecimateKept(stderrText) {
  const text = String(stderrText || '');
  const keptTimes = [...text.matchAll(/\bkeep pts:\d+ pts_time:([0-9.]+)/g)]
    .map((match) => Number(match[1]))
    .filter((value) => Number.isFinite(value));
  return {
    kept: (text.match(/\bkeep pts:/g) || []).length,
    dropped: (text.match(/\bdrop pts:/g) || []).length,
    lastKeptSeconds: keptTimes.length > 0 ? keptTimes[keptTimes.length - 1] : null,
  };
}

function assessRecording({ probe, decimate, expectedSeconds }) {
  const reasons = [];
  const nominalFps = probe.fps > 0 ? probe.fps : 25;
  const minimumFrames = 0.8 * expectedSeconds * nominalFps;
  if (probe.frames === null || probe.frames < minimumFrames) {
    reasons.push(`decoded frames ${probe.frames === null ? 'unavailable' : probe.frames}`
      + `; expected at least ${minimumFrames}`);
  }
  const totalDecimateFrames = decimate.kept + decimate.dropped;
  const minimumKept = Math.max(6, 0.6 * expectedSeconds);
  if (totalDecimateFrames === 0) {
    reasons.push('mpdecimate logged no frames (ffmpeg debug output missing?)');
  } else if (decimate.kept < minimumKept) {
    reasons.push(`mpdecimate kept only ${decimate.kept} unique frames; expected at least ${minimumKept}`);
  }
  const lastKept = decimate.lastKeptSeconds;
  const latestAllowedFreeze = expectedSeconds - FROZEN_TAIL_SECONDS;
  if (totalDecimateFrames > 0 && (lastKept === null || lastKept < latestAllowedFreeze)) {
    reasons.push(`last unique frame at ${lastKept === null ? 'unknown' : lastKept}s; `
      + `expected one after ${latestAllowedFreeze.toFixed(1)}s`);
  }
  return { ok: reasons.length === 0, reasons };
}

function displayCommand(program, args) {
  return [program, ...args].map((arg) => (/\s/.test(arg) ? JSON.stringify(arg) : arg)).join(' ');
}

function runCommand(program, args) {
  const result = childProcess.spawnSync(program, args, {
    encoding: 'utf8',
    maxBuffer: MAX_BUFFER_BYTES,
  });
  if (result.error || result.status !== 0) {
    const stderrLines = String(result.stderr || '').trimEnd().split(/\r?\n/);
    const stderrTail = stderrLines.slice(-20).join('\n');
    const status = result.error ? result.error.message : `exit ${result.status}`;
    throw new Error(`Command failed (${status}): ${displayCommand(program, args)}`
      + (stderrTail ? `\n${stderrTail}` : ''));
  }
  return result;
}

function assertBasename(value) {
  const basename = String(value || '');
  if (!basename || basename === '.' || basename === '..' || path.basename(basename) !== basename) {
    throw new Error(`Invalid demo basename: ${basename}`);
  }
  return basename;
}

function clipFileName(basename, extension) {
  return `${assertBasename(basename)}.${extension}`;
}

function metaPaths(artifactsDir, requestedBasenames) {
  if (requestedBasenames.length > 0) {
    return requestedBasenames.map((basename) => (
      path.join(artifactsDir, clipFileName(basename, 'meta.json'))
    ));
  }
  return fs.readdirSync(artifactsDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.meta.json'))
    .map((entry) => path.join(artifactsDir, entry.name))
    .sort();
}

function encodeClip({ artifactsDir, mediaDir, metaPath }) {
  const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  const basename = assertBasename(meta.outputBasename);
  const input = path.join(artifactsDir, clipFileName(basename, 'webm'));
  const palettePath = path.join(artifactsDir, clipFileName(basename, 'palette.png'));
  const gifOutput = path.join(mediaDir, clipFileName(basename, 'gif'));
  const mp4Output = path.join(mediaDir, clipFileName(basename, 'mp4'));

  if (!fs.existsSync(input)) {
    throw new Error(`Missing recording: ${input}`);
  }

  const probeResult = runCommand('ffprobe', buildFrameProbeArgs(input));
  const decimateResult = runCommand('ffmpeg', buildDecimateArgs(input));
  const assessment = assessRecording({
    probe: parseFrameProbe(probeResult.stdout),
    decimate: countDecimateKept(decimateResult.stderr),
    expectedSeconds: meta.recordedMs / 1000,
  });
  if (!assessment.ok) {
    for (const reason of assessment.reasons) {
      console.error(`${basename}: FROZEN? ${reason}`);
    }
    return false;
  }

  let settings = Object.assign({}, DEFAULT_ENCODE);
  let ladderIndex = 0;
  let overBudget = false;
  while (true) {
    runCommand('ffmpeg', buildGifPaletteArgs({ input, palettePath, settings, meta }));
    runCommand('ffmpeg', buildGifEncodeArgs({
      input,
      palettePath,
      output: gifOutput,
      settings,
      meta,
    }));
    if (fs.statSync(gifOutput).size <= settings.sizeBudgetBytes) {
      break;
    }
    const next = nextLadderStep(settings, ladderIndex);
    if (!next) {
      overBudget = true;
      break;
    }
    fs.rmSync(gifOutput);
    settings = next.settings;
    ladderIndex = next.index;
  }

  // The MP4 is not size-laddered: it always keeps the default width.
  runCommand('ffmpeg', buildMp4Args({ input, output: mp4Output, settings: DEFAULT_ENCODE, meta }));
  const gifBytes = fs.statSync(gifOutput).size;
  const mp4Bytes = fs.statSync(mp4Output).size;
  const budgetStatus = overBudget ? ' | OVER BUDGET' : '';
  console.log(`${basename}: gif ${gifBytes} bytes (fps ${settings.fps}, width ${settings.width}, `
    + `colors ${settings.maxColors}) | mp4 ${mp4Bytes} bytes${budgetStatus}`);
  return true;
}

function main() {
  const repoRoot = path.resolve(__dirname, '..', '..');
  const artifactsDir = path.join(repoRoot, 'artifacts', 'demo');
  const mediaDir = path.join(repoRoot, 'docs', 'media');
  fs.mkdirSync(mediaDir, { recursive: true });

  let skipped = false;
  for (const metaPath of metaPaths(artifactsDir, process.argv.slice(2))) {
    if (!encodeClip({ artifactsDir, mediaDir, metaPath })) {
      skipped = true;
    }
  }
  if (skipped) {
    process.exitCode = 1;
  }
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

module.exports = {
  DEFAULT_ENCODE, LADDER, nextLadderStep, trimWindow, videoFilter,
  buildGifPaletteArgs, buildGifEncodeArgs, buildMp4Args,
  buildFrameProbeArgs, buildDecimateArgs, parseFrameProbe,
  countDecimateKept, assessRecording,
};
