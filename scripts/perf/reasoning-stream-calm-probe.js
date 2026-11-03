#!/usr/bin/env node
/* global window, document, requestAnimationFrame */
'use strict';

// Row 101 Phase 0: headless, real-layout replay probe for "how hectic is the
// chat timeline while reasoning streams fast". It bundles the jsdom-free shell
// stub of tests/helpers, serves a tree's real index.html/renderer/styles to a
// headless Chromium over a fake origin, replays a synthetic provider reasoning
// stream (production wire shape and cadence) through window.jennyShell, and
// samples every painted frame. Prints one JSON object (stdout and --out).
//
//   node scripts/perf/reasoning-stream-calm-probe.js [--root <repoDir>]
//     [--rates 60,100,150,200] [--duration-s 20] [--view thinking|answers] [--out <file.json>]
//
// Always headless; never opens a window. Progress goes to stderr.

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const esbuild = require('esbuild');
const { chromium } = require('playwright-core');
const {
  buildReasoningPhaseEvent,
  createSyntheticReasoningStream,
  summarizeFrames,
} = require('./reasoning-stream-calm-metrics');

const SCRIPT_DIR = __dirname;
const ORIGIN = 'http://jenny.probe';
const BUNDLE_PATH = '/__probe/bundle.js';
const IDS = { sessionId: 'sess_calm_probe', streamId: 'stream_calm_probe' };
const FRAME_MS = 20;
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm',
  '.map': 'application/json',
};

function log(message) {
  process.stderr.write(`[calm-probe] ${message}\n`);
}

function fail(message) {
  process.stderr.write(`[calm-probe] ERROR: ${message}\n`);
  process.exit(1);
}

function parseArgs(argv) {
  const args = {
    root: path.resolve(SCRIPT_DIR, '..', '..'),
    rates: [60, 100, 150, 200],
    durationS: 20,
    view: 'thinking',
    out: '',
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === '--root') { args.root = path.resolve(value); index += 1; }
    else if (flag === '--rates') {
      args.rates = String(value).split(',').map(Number).filter((rate) => Number.isFinite(rate) && rate > 0);
      index += 1;
    }
    else if (flag === '--duration-s') { args.durationS = Number(value); index += 1; }
    else if (flag === '--view') { args.view = value; index += 1; }
    else if (flag === '--out') { args.out = path.resolve(value); index += 1; }
    else fail(`unknown argument ${flag}`);
  }
  if (!args.rates.length) fail('--rates needs at least one positive number');
  if (!(args.durationS > 0)) fail('--duration-s must be a positive number');
  if (args.view !== 'thinking' && args.view !== 'answers') fail('--view must be thinking or answers');
  if (!fs.existsSync(path.join(args.root, 'index.html'))) fail(`no index.html under --root ${args.root}`);
  return args;
}

function findBrowser() {
  const candidates = [
    process.env.JENNY_TEST_CHROMIUM,
    process.platform === 'win32' && 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    process.platform === 'win32' && 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    chromium.executablePath(),
  ];
  const found = candidates.find((candidate) => candidate && fs.existsSync(candidate));
  if (!found) fail('no Chromium found; set JENNY_TEST_CHROMIUM to a Chrome/Edge executable');
  return found;
}

function gitHead(root) {
  try {
    return execFileSync('git', ['-C', root, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim();
  } catch (_error) {
    return 'unknown';
  }
}

// The harness helpers import node builtins and one service at module load. In
// the browser bundle fs/path become tiny stubs (fs serves index.html) and the
// session-lifecycle service (only persistUserTurn, unused here) an empty stub.
function createBundlePlugin(root) {
  const stubs = path.join(SCRIPT_DIR, 'reasoning-stream-calm-node-stubs.js');
  const domShim = path.join(SCRIPT_DIR, 'reasoning-stream-calm-dom-shim.js');
  const helpersDir = path.join(root, 'tests', 'helpers');
  return {
    name: 'calm-probe',
    setup(build) {
      build.onResolve({ filter: /^probe-harness$/ }, () => ({ path: path.join(helpersDir, 'renderer-shell-harness.js') }));
      build.onResolve({ filter: /^probe-feature-flags$/ }, () => ({ path: path.join(root, 'services', 'feature-flags.js') }));
      build.onResolve({ filter: /renderer-shell-harness-dom$/ }, () => ({ path: domShim }));
      build.onResolve({ filter: /chat-stream-session-lifecycle$/ }, () => ({ path: 'lifecycle', namespace: 'probe-stub' }));
      build.onResolve({ filter: /^(node:)?(fs|path)$/ }, (args) => ({ path: args.path.replace(/^node:/, ''), namespace: 'probe-stub' }));
      build.onLoad({ filter: /.*/, namespace: 'probe-stub' }, (args) => {
        if (args.path === 'lifecycle') return { contents: 'module.exports = { persistUserTurn() {} };', loader: 'js' };
        return { contents: `module.exports = require(${JSON.stringify(stubs)}).${args.path};`, loader: 'js', resolveDir: SCRIPT_DIR };
      });
    },
  };
}

async function buildBundle(root, indexHtml) {
  const result = await esbuild.build({
    entryPoints: [path.join(SCRIPT_DIR, 'reasoning-stream-calm-shim.js')],
    bundle: true,
    write: false,
    format: 'iife',
    platform: 'browser',
    target: 'chrome120',
    logLevel: 'silent',
    // Bundled service modules read process.env/platform at load; the renderer scripts outside the bundle never see this.
    banner: { js: "var process = { env: {}, platform: 'win32', versions: {}, argv: [], cwd: function () { return '/'; } };" },
    define: {
      __PROBE_INDEX_HTML__: JSON.stringify(indexHtml),
      __dirname: JSON.stringify('/probe/tests/helpers'),
      'process.env.NODE_ENV': '"production"',
    },
    plugins: [createBundlePlugin(root)],
  }).catch((error) => {
    const detail = (error.errors || []).map((entry) => `${entry.location?.file || ''}:${entry.location?.line || ''} ${entry.text}`).join('\n');
    fail(`esbuild failed to bundle the shell stub:\n${detail || error.message}`);
  });
  return result.outputFiles[0].text;
}

function prepareIndexHtml(rawHtml) {
  const withoutCsp = rawHtml.replace(/<meta\s+http-equiv="Content-Security-Policy"[\s\S]*?>/i, '');
  const firstScript = withoutCsp.search(/<script\b/i);
  if (firstScript < 0) fail('index.html has no <script> to inject before');
  return `${withoutCsp.slice(0, firstScript)}<script src="${BUNDLE_PATH}"></script>\n  ${withoutCsp.slice(firstScript)}`;
}

async function installRoutes(page, root, html, bundle) {
  await page.route(`${ORIGIN}/**`, async (route) => {
    const url = new URL(route.request().url());
    const pathname = decodeURIComponent(url.pathname);
    if (pathname === BUNDLE_PATH) {
      return route.fulfill({ status: 200, contentType: MIME['.js'], body: bundle });
    }
    if (pathname === '/' || pathname === '/index.html') {
      return route.fulfill({ status: 200, contentType: MIME['.html'], body: html });
    }
    const file = path.resolve(root, `.${pathname}`);
    if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      return route.fulfill({ status: 404, body: '' });
    }
    return route.fulfill({
      status: 200,
      contentType: MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      body: fs.readFileSync(file),
    });
  });
}

// Runs in the page. Samples one record per painted frame (rAF, then a 0 ms
// timeout so the read happens after the paint) and replays the wire.
async function runInPage({ events, startEvents, durationMs, sessionId, streamId }) {
  const shell = window.jennyShell;
  const emit = (payload) => shell.__emitChat({ sessionId, streamId, ...payload });
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  const longTasks = [];
  const layoutShifts = [];
  const observers = [];
  const observe = (type, onEntry) => {
    try {
      const observer = new PerformanceObserver((list) => list.getEntries().forEach(onEntry));
      observer.observe({ type });
      observers.push(observer);
    } catch (_error) { /* entry type unsupported */ }
  };
  observe('longtask', (entry) => longTasks.push({ start: entry.startTime, duration: entry.duration }));
  observe('layout-shift', (entry) => layoutShifts.push({ value: entry.value, hadRecentInput: entry.hadRecentInput }));

  for (const payload of startEvents) await emit(payload);

  const panelBody = () => {
    const bodies = document.querySelectorAll('.reasoning-row-panel-body');
    return bodies.length ? bodies[bodies.length - 1] : null;
  };
  const scroller = document.getElementById('chatThreadScroll');
  const seenSoftLandings = new WeakSet();
  const frames = [];
  const unitAnimationNames = {};
  let sampling = true;

  function sample() {
    const body = panelBody();
    const running = { softLanding: 0, tokenFade: 0, otherUnit: 0 };
    let softLandingStarted = 0;
    for (const animation of document.getAnimations()) {
      if (animation.playState !== 'running') continue;
      const name = animation.animationName;
      if (name === 'reasoning-soft-landing') {
        running.softLanding += 1;
        if (!seenSoftLandings.has(animation)) {
          seenSoftLandings.add(animation);
          softLandingStarted += 1;
        }
      } else if (name === 'chat-stream-token-in') {
        running.tokenFade += 1;
      } else {
        const target = animation.effect && animation.effect.target;
        if (target && target.closest && target.closest('.reasoning-stream-unit')) {
          running.otherUnit += 1;
          unitAnimationNames[name || animation.constructor.name] = true;
        }
      }
    }
    frames.push({
      t: performance.now(),
      textLength: body ? body.textContent.length : 0,
      // Row 101 Phase 2: the live box's own scroll state.
      box: body ? {
        marked: body.getAttribute('data-live-box') === 'true',
        scrollTop: body.scrollTop,
        scrollHeight: body.scrollHeight,
        clientHeight: body.clientHeight,
      } : null,
      scrollTop: scroller ? scroller.scrollTop : 0,
      scrollHeight: scroller ? scroller.scrollHeight : 0,
      clientHeight: scroller ? scroller.clientHeight : 0,
      running,
      softLandingStarted,
    });
  }
  function onFrame() {
    if (!sampling) return;
    setTimeout(sample, 0);
    requestAnimationFrame(onFrame);
  }
  requestAnimationFrame(onFrame);

  // Replay: a deadline-driven loop so a slow main thread delivers late frames
  // in a burst (like a backed-up IPC queue) instead of stretching the stream.
  const started = performance.now();
  let next = 0;
  while (performance.now() - started < durationMs) {
    const elapsed = performance.now() - started;
    while (next < events.length && events[next].atMs <= elapsed) {
      await emit(events[next].payload);
      next += 1;
    }
    await sleep(Math.max(1, Math.min(8, (events[next] ? events[next].atMs : durationMs) - (performance.now() - started))));
  }
  sampling = false;
  await sleep(100);
  observers.forEach((observer) => observer.disconnect());

  const body = panelBody();
  // Row 101 Phase 2: the cap against its formula, and again at Large text size.
  const boxCap = (() => {
    if (!body) return null;
    const px = (value) => Number.parseFloat(value) || 0;
    const read = () => {
      const style = window.getComputedStyle(body);
      const em = px(style.fontSize);
      const vars = style;
      const formula = Math.max(1.62 * em * 10, px(vars.getPropertyValue('--chat-thread-viewport-h'))
        - px(vars.getPropertyValue('--chat-thread-offset')) - px(vars.getPropertyValue('--composer-safe-offset'))
        - px(vars.getPropertyValue('--tl-row-h')) - 3 * em);
      return { capPx: px(style.maxHeight), formulaPx: Math.round(formula * 10) / 10, clientHeight: body.clientHeight,
        viewportVar: vars.getPropertyValue('--chat-thread-viewport-h').trim(), fontSizePx: em };
    };
    const atDefault = read();
    const root = document.documentElement;
    const previous = root.style.getPropertyValue('--font-scale');
    root.style.setProperty('--font-scale', '1.3');
    const atLarge = read();
    if (previous) root.style.setProperty('--font-scale', previous); else root.style.removeProperty('--font-scale');
    return { atDefault, atLarge };
  })();
  return {
    frames,
    longTasks,
    layoutShifts,
    emitted: next,
    finalTextLength: body ? body.textContent.length : 0,
    transcriptViewDefault: window.__rendererState ? window.__rendererState.transcriptViewDefault : '',
    panelFound: Boolean(body),
    otherUnitAnimationNames: Object.keys(unitAnimationNames),
    boxCap,
  };
}

// Row 101 Phase 2: once the box is full (its scrollHeight passes its client
// height), the timeline should hold still and the box should track its bottom.
function summarizeLiveBox(frames, durationMs) {
  const fullAt = frames.findIndex((frame) => frame.box && frame.box.scrollHeight > frame.box.clientHeight + 1);
  if (fullAt < 0) return { boxFilled: false };
  const after = frames.slice(fullAt);
  let travel = 0;
  const lags = [];
  for (let index = 1; index < after.length; index += 1) {
    travel += Math.abs(after[index].scrollTop - after[index - 1].scrollTop);
    const box = after[index].box;
    if (box) lags.push(box.scrollHeight - box.clientHeight - box.scrollTop);
  }
  lags.sort((a, b) => a - b);
  const spanS = Math.max((after[after.length - 1].t - after[0].t) / 1000, 0.001);
  return {
    boxFilled: true,
    boxFilledAtS: Math.round((after[0].t - frames[0].t) / 100) / 10,
    boxMarked: after.every((frame) => !frame.box || frame.box.marked),
    timelineTravelAfterFullPxPerS: Math.round((travel / spanS) * 10) / 10,
    boxBottomLagP50Px: lags.length ? Math.round(lags[Math.floor(lags.length * 0.5)]) : 0,
    boxBottomLagP95Px: lags.length ? Math.round(lags[Math.min(lags.length - 1, Math.floor(lags.length * 0.95))]) : 0,
    boxClientHeightPx: after[after.length - 1].box ? after[after.length - 1].box.clientHeight : 0,
    durationS: durationMs / 1000,
  };
}

// Panel heights through the settle collapse: they must never grow.
async function sampleSettleCollapse() {
  const panels = document.querySelectorAll('.reasoning-row-panel');
  const panel = panels.length ? panels[panels.length - 1] : null;
  const heights = [];
  const started = performance.now();
  await new Promise((resolve) => {
    const step = () => {
      heights.push(panel && panel.isConnected ? panel.getBoundingClientRect().height : -1);
      if (performance.now() - started < 900) requestAnimationFrame(step); else resolve();
    };
    requestAnimationFrame(step);
  });
  const valid = heights.filter((h) => h >= 0);
  let maxRise = 0;
  for (let index = 1; index < valid.length; index += 1) maxRise = Math.max(maxRise, valid[index] - valid[index - 1]);
  return { first: Math.round(valid[0] || 0), last: Math.round(valid[valid.length - 1] || 0), maxRisePx: Math.round(maxRise * 10) / 10,
    samples: valid.length, replaced: heights.includes(-1) };
}

async function waitForBoot(page) {
  await page.waitForFunction(
    () => window.jennyShell && window.jennyShell.__state && window.jennyShell.__state.lifecycleReadySignals > 0,
    null,
    { timeout: 30000 },
  ).catch(() => fail('renderer never signalled ready (lifecycle.signalReady) within 30 s'));
  await page.waitForFunction(() => !document.getElementById('startupOverlay'), null, { timeout: 15000 })
    .catch(() => fail('startup curtain never left the DOM within 15 s'));
  await page.waitForSelector('#chatInput', { timeout: 10000 })
    .catch(() => fail('#chatInput never appeared'));
}

async function runRate({ browser, rate, args, html, bundle }) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(String(error.message || error)));
  if (process.env.CALM_PROBE_DEBUG) {
    page.on('console', (message) => log(`console.${message.type()}: ${message.text()}`));
    page.on('pageerror', (error) => log(`pageerror: ${error.message}`));
    page.on('requestfailed', (request) => log(`requestfailed: ${request.url()}`));
  }
  await page.addInitScript(`window.__PROBE_CONFIG__ = ${JSON.stringify({ view: args.view })};`);
  await installRoutes(page, args.root, html, bundle);
  try {
    await page.goto(`${ORIGIN}/`, { waitUntil: 'load' });
    await waitForBoot(page);
    await page.fill('#chatInput', 'think hard about the parser');
    await page.click('#sendButton');
    await page.waitForFunction(() => window.jennyShell.__state.chatCalls.length > 0, null, { timeout: 10000 })
      .catch(() => fail('sending from the composer never reached chat.startStream'));

    const durationMs = Math.round(args.durationS * 1000);
    const events = createSyntheticReasoningStream({
      seed: 1, ratePerSec: rate, durationMs, frameMs: FRAME_MS, ...IDS, snapshotEveryMs: 2000,
    });
    const startEvents = [
      { type: 'started' },
      buildReasoningPhaseEvent('phase_started'),
    ];
    const result = await page.evaluate(runInPage, {
      events, startEvents, durationMs, sessionId: IDS.sessionId, streamId: IDS.streamId,
    });
    const settle = page.evaluate(sampleSettleCollapse);
    await page.evaluate(({ sessionId, streamId }) => window.jennyShell.__emitChat({
      sessionId, streamId, type: 'complete', content: '', interactiveProtocolDrift: false, interactiveProtocolDriftPreview: '',
    }), IDS);
    const settleCollapse = await settle;

    if (!result.panelFound && args.view === 'thinking') {
      fail(`the reasoning panel (.reasoning-row-panel-body) never appeared at ${rate} tok/s`);
    }
    const expectedChars = Math.round(rate * args.durationS * 4);
    return {
      rate,
      durationS: args.durationS,
      expectedChars,
      finalTextLength: result.finalTextLength,
      panelFound: result.panelFound,
      transcriptViewDefault: result.transcriptViewDefault,
      eventsEmitted: result.emitted,
      eventsPlanned: events.length,
      ...summarizeFrames(result.frames, {
        longTasks: result.longTasks,
        layoutShifts: result.layoutShifts,
        durationMs,
      }),
      otherUnitAnimationNames: result.otherUnitAnimationNames,
      liveBox: { ...summarizeLiveBox(result.frames, durationMs), cap: result.boxCap, settleCollapse },
      pageErrors: pageErrors.slice(0, 5),
    };
  } finally {
    await context.close();
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const executablePath = findBrowser();
  const rawHtml = fs.readFileSync(path.join(args.root, 'index.html'), 'utf8');
  log(`bundling shell stub for ${args.root}`);
  const bundle = await buildBundle(args.root, rawHtml);
  const html = prepareIndexHtml(rawHtml);

  const browser = await chromium.launch({ executablePath, headless: true });
  const runs = [];
  try {
    for (const rate of args.rates) {
      log(`rate ${rate} tok/s for ${args.durationS} s (${args.view} view)`);
      runs.push(await runRate({ browser, rate, args, html, bundle }));
    }
  } finally {
    await browser.close();
  }
  const output = {
    root: args.root,
    gitHead: gitHead(args.root),
    view: args.view,
    browser: executablePath,
    runs,
  };
  const text = `${JSON.stringify(output, null, 2)}\n`;
  if (args.out) {
    fs.mkdirSync(path.dirname(args.out), { recursive: true });
    fs.writeFileSync(args.out, text);
  }
  process.stdout.write(text);
}

main().catch((error) => fail(error && error.stack ? error.stack : String(error)));
