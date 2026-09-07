'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
  DEFAULT_ENCODE,
  LADDER,
  nextLadderStep,
  buildGifPaletteArgs,
  buildGifEncodeArgs,
  buildMp4Args,
  parseFrameProbe,
  countDecimateKept,
  assessRecording,
} = require('../scripts/demo/encode-gif');

const META = Object.freeze({
  leadInMs: 200,
  recordedMs: 12800,
  tailHoldMs: 1500,
});

test('GIF builders produce the exact default ffmpeg arguments', () => {
  assert.deepStrictEqual(buildGifPaletteArgs({
    input: 'clip.webm',
    palettePath: 'clip.palette.png',
    settings: DEFAULT_ENCODE,
    meta: META,
  }), [
    '-y',
    '-ss', '0.2',
    '-to', '12.8',
    '-i', 'clip.webm',
    '-vf', 'fps=15,scale=1280:-2:flags=lanczos,tpad=stop_mode=clone:stop_duration=1.5,fade=t=in:st=0:d=0.3,fade=t=out:st=13.65:d=0.45,palettegen=max_colors=192:stats_mode=diff',
    'clip.palette.png',
  ]);

  assert.deepStrictEqual(buildGifEncodeArgs({
    input: 'clip.webm',
    palettePath: 'clip.palette.png',
    output: 'clip.gif',
    settings: DEFAULT_ENCODE,
    meta: META,
  }), [
    '-y',
    '-ss', '0.2',
    '-to', '12.8',
    '-i', 'clip.webm',
    '-i', 'clip.palette.png',
    '-lavfi', 'fps=15,scale=1280:-2:flags=lanczos,tpad=stop_mode=clone:stop_duration=1.5,fade=t=in:st=0:d=0.3,fade=t=out:st=13.65:d=0.45[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=3:diff_mode=rectangle',
    '-loop', '0',
    'clip.gif',
  ]);
});

test('GIF builders omit -to when recordedMs is missing', () => {
  const meta = { leadInMs: 200, tailHoldMs: 1500 };
  const paletteArgs = buildGifPaletteArgs({
    input: 'clip.webm',
    palettePath: 'clip.palette.png',
    settings: DEFAULT_ENCODE,
    meta,
  });
  const gifArgs = buildGifEncodeArgs({
    input: 'clip.webm',
    palettePath: 'clip.palette.png',
    output: 'clip.gif',
    settings: DEFAULT_ENCODE,
    meta,
  });
  assert.strictEqual(paletteArgs.includes('-to'), false);
  assert.strictEqual(gifArgs.includes('-to'), false);
  // No known length: fade in only, never a fade-out at an unknown time.
  assert.ok(gifArgs.some((arg) => arg.includes('fade=t=in:st=0:d=0.3')));
  assert.strictEqual(gifArgs.some((arg) => arg.includes('fade=t=out')), false);
});

test('MP4 arguments use the web-compatible H.264 path without GIF filters', () => {
  const args = buildMp4Args({
    input: 'clip.webm',
    output: 'clip.mp4',
    settings: DEFAULT_ENCODE,
    meta: META,
  });
  assert.ok(args.some((arg) => arg.includes('format=yuv420p')));
  assert.ok(args.some((arg) => arg.includes('fade=t=out:st=13.65:d=0.45,format=yuv420p')), 'the MP4 fades out before the pixel format');
  assert.ok(args.includes('libx264'));
  assert.ok(args.includes('+faststart'));
  assert.strictEqual(args.some((arg) => arg.includes('fps=')), false);
  assert.strictEqual(args.some((arg) => arg.includes('palettegen')), false);
});

test('the size ladder walks six cumulative strictly-lower rungs', () => {
  let settings = DEFAULT_ENCODE;
  let index = 0;

  for (let rung = 0; rung < LADDER.length; rung += 1) {
    const next = nextLadderStep(settings, index);
    assert.ok(next);
    assert.ok(next.settings.fps <= settings.fps);
    assert.ok(next.settings.width <= settings.width);
    assert.ok(next.settings.maxColors <= settings.maxColors);
    assert.ok(
      next.settings.fps < settings.fps
        || next.settings.width < settings.width
        || next.settings.maxColors < settings.maxColors
    );
    settings = next.settings;
    index = next.index;
  }

  assert.strictEqual(index, 6);
  assert.strictEqual(nextLadderStep(settings, index), null);
});

test('parseFrameProbe reads frame count, rational fps, and duration', () => {
  const sample = JSON.stringify({
    streams: [{
      nb_read_frames: '320',
      r_frame_rate: '25/1',
      duration: '12.800000',
    }],
  });
  assert.deepStrictEqual(parseFrameProbe(sample), {
    frames: 320,
    fps: 25,
    durationSeconds: 12.8,
  });
});

test('countDecimateKept counts kept and dropped debug lines and the last kept time', () => {
  const stderr = [
    '[Parsed_mpdecimate_0] keep pts:0 pts_time:0',
    '[Parsed_mpdecimate_0] drop pts:1 pts_time:0.04',
    '[Parsed_mpdecimate_0] keep pts:2 pts_time:0.08',
    '[Parsed_mpdecimate_0] drop pts:3 pts_time:0.12',
    '[Parsed_mpdecimate_0] keep pts:4 pts_time:10.28',
  ].join('\n');
  assert.deepStrictEqual(countDecimateKept(stderr), { kept: 3, dropped: 2, lastKeptSeconds: 10.28 });
  assert.deepStrictEqual(countDecimateKept(''), { kept: 0, dropped: 0, lastKeptSeconds: null });
});

test('assessRecording accepts static-but-live clips and rejects frozen signatures', () => {
  // A palette reel: mostly static, 26 unique frames across 11.3 s, last change near the end.
  const staticUi = assessRecording({
    probe: { frames: 300, fps: 25 },
    decimate: { kept: 26, dropped: 274, lastKeptSeconds: 10.28 },
    expectedSeconds: 11.3,
  });
  assert.deepStrictEqual(staticUi, { ok: true, reasons: [] });

  const tooFewFrames = assessRecording({
    probe: { frames: 100, fps: 25 },
    decimate: { kept: 80, dropped: 20, lastKeptSeconds: 12 },
    expectedSeconds: 12.8,
  });
  assert.strictEqual(tooFewFrames.ok, false);
  assert.ok(tooFewFrames.reasons.length > 0);

  // Occluded from the start: one unique frame, nothing after it.
  const frozenFromStart = assessRecording({
    probe: { frames: 320, fps: 25 },
    decimate: { kept: 1, dropped: 319, lastKeptSeconds: 0 },
    expectedSeconds: 12.8,
  });
  assert.strictEqual(frozenFromStart.ok, false);
  assert.ok(frozenFromStart.reasons.length >= 2);

  // Froze after 3 s: enough unique frames early, none near the end.
  const frozenLater = assessRecording({
    probe: { frames: 320, fps: 25 },
    decimate: { kept: 40, dropped: 280, lastKeptSeconds: 3.1 },
    expectedSeconds: 12.8,
  });
  assert.strictEqual(frozenLater.ok, false);
  assert.match(frozenLater.reasons.join(' '), /last unique frame/);

  const noDecimateLog = assessRecording({
    probe: { frames: 320, fps: 25 },
    decimate: { kept: 0, dropped: 0, lastKeptSeconds: null },
    expectedSeconds: 12.8,
  });
  assert.strictEqual(noDecimateLog.ok, false);

  const highFpsProbe = assessRecording({
    probe: { frames: 320, fps: 60 },
    decimate: { kept: 240, dropped: 80, lastKeptSeconds: 12 },
    expectedSeconds: 12.8,
  });
  assert.strictEqual(highFpsProbe.ok, false, 'frame floor scales with the probed fps');
});
