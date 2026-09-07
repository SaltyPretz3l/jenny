'use strict';
/* global window, document */
// `window` and `document` appear only inside Playwright renderer callbacks.

// Owner-run demo clip recorder.
//
// OWNER-RUN ONLY. This opens a real window and needs playwright-core, so it is
// deliberately not wired into `npm test` / CI and must not be launched by
// autonomous agents.

const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const { pollReadiness, navigateToView } = require('../../capture-ui');
const { buildPreloadBundle } = require('../build/build-preload');
const {
  DEMO_SCENES,
  STEP_TYPES,
  RECORDING,
  outputFileName,
  assertScenesValid,
} = require('./demo-scenes');
const { OVERLAY_INSTALL_SCRIPT, DEMO_STYLE_CSS, typingDelays } = require('./demo-presentation');
const { seedDemoProfile, cleanupDemoProfile } = require('./demo-profile');
const { trackDirectory, trackProcess } = require('../../tests/helpers/resource-cleanup');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_OUTPUT_DIR = path.join(REPO_ROOT, 'artifacts', 'demo');
const DEFAULT_READY_TIMEOUT_MS = 90_000;
let preloadBuildPromise = null;

function scrubbedJennyEnv() {
  return Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith('JENNY_'))
  );
}

function ensurePreloadBundle() {
  if (!preloadBuildPromise) {
    preloadBuildPromise = Promise.resolve()
      .then(() => buildPreloadBundle({ root: REPO_ROOT }))
      .catch((error) => {
        preloadBuildPromise = null;
        throw error;
      });
  }
  return preloadBuildPromise;
}

function currentCommit() {
  const result = childProcess.spawnSync('git', ['rev-parse', 'HEAD'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return result.status === 0 ? String(result.stdout || '').trim() : '';
}

async function runScene(scene, {
  outputDir = DEFAULT_OUTPUT_DIR,
  readyTimeoutMs = DEFAULT_READY_TIMEOUT_MS,
} = {}) {
  assertScenesValid([scene]);
  const { base, profile, replayScriptPath } = seedDemoProfile(scene);
  let app = null;
  try {
    await ensurePreloadBundle();
    trackDirectory(profile);

    // Lazy so syntax checks and importing this owner-run driver do not force
    // playwright-core (a devDependency) to resolve.
    const { _electron: electron } = require('playwright-core');
    app = await electron.launch({
      args: [
        '.',
        `--force-device-scale-factor=${RECORDING.deviceScaleFactor}`,
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding',
        '--disable-features=CalculateNativeWinOcclusion',
      ],
      cwd: REPO_ROOT,
      env: {
        ...scrubbedJennyEnv(),
        JENNY_AGENT_DEV: '1',
        JENNY_USER_DATA_DIR: profile,
        JENNY_WINDOW_REVEAL_INACTIVE: '1',
        ELECTRON_ENABLE_LOGGING: '1',
        JENNY_REPLAY_DELAY_MS: String(scene.replayDelayMs),
        ...(replayScriptPath ? { JENNY_REPLAY_SCRIPT: replayScriptPath } : {}),
        ...scene.env,
      },
    });
    trackProcess({ pid: app.process()?.pid });

    const page = await app.firstWindow();
    await page.waitForFunction(() => Boolean(window.__jennyAgent), null, {
      timeout: readyTimeoutMs,
    });
    await pollReadiness(page, readyTimeoutMs);

    // The window must have come up maximized (window-state.json seed) with a
    // viewport large enough for the layout; the capture is scaled to
    // captureWidth so clips match each other regardless of the display.
    const maximized = await app.evaluate(({ BrowserWindow }) => (
      BrowserWindow.getAllWindows().some((candidate) => candidate.isMaximized())
    ));
    const [width, height] = await page.evaluate(() => [window.innerWidth, window.innerHeight]);
    if (!maximized || width < RECORDING.minViewportWidth || height < RECORDING.minViewportHeight) {
      throw new Error(
        `scene ${scene.id}: window not maximized or viewport ${width}x${height} below ${RECORDING.minViewportWidth}x${RECORDING.minViewportHeight}`
      );
    }
    const captureWidth = RECORDING.captureWidth;
    const captureHeight = Math.round((captureWidth * height) / width / 2) * 2;

    fs.mkdirSync(outputDir, { recursive: true });
    const webmPath = path.join(outputDir, outputFileName(scene, 'webm'));
    let recordStartedAt = null;
    // Centre of an element in viewport CSS px (the overlay cursor and the
    // real mouse share this frame).
    const centerOf = async (selector) => {
      const box = await page.locator(selector).first().boundingBox();
      if (!box) {
        throw new Error(`scene ${scene.id}: ${selector} has no layout box`);
      }
      return { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) };
    };
    const glideTo = async (selector, ms) => {
      const target = await centerOf(selector);
      const from = await page.evaluate(() => window.__demoPresentation.position());
      const distance = Math.hypot(target.x - from.x, target.y - from.y);
      const duration = ms || Math.max(420, Math.min(950, Math.round(distance * 1.1)));
      await page.evaluate(({ x, y, duration: d }) => window.__demoPresentation.moveTo(x, y, d), { ...target, duration });
      await page.mouse.move(target.x, target.y, { steps: 4 });
      return target;
    };
    for (const step of scene.steps) {
      switch (step.type) {
        case 'record-start': {
          // The presentation overlay goes in before the first frame so the
          // cursor and the hidden replay-only chrome never pop mid-clip.
          await page.addStyleTag({ content: DEMO_STYLE_CSS });
          await page.evaluate(OVERLAY_INSTALL_SCRIPT);
          await page.evaluate(({ crossfade, x, y }) => {
            window.__demoPresentation.setCrossfade(crossfade);
            window.__demoPresentation.show(x, y);
          }, { crossfade: scene.presentation.crossfade, x: Math.round(width * 0.9), y: Math.round(height * 0.55) });
          await page.mouse.move(Math.round(width * 0.9), Math.round(height * 0.55));
          await page.waitForTimeout(350);
          await page.screencast.start({
            path: webmPath,
            size: { width: captureWidth, height: captureHeight },
          });
          recordStartedAt = Date.now();
          break;
        }
        case 'goto-view':
          await navigateToView(page, step.view);
          break;
        case 'send-prompt': {
          const sent = await page.evaluate((text) => window.__jennyAgent.sendPrompt(text), step.text);
          if (sent !== true) {
            throw new Error(`scene ${scene.id}: sendPrompt returned ${sent} (composer not mounted?)`);
          }
          break;
        }
        case 'wait-idle': {
          const idle = await page.evaluate(
            (ms) => window.__jennyAgent.waitForIdle({ timeoutMs: ms }),
            step.timeoutMs
          );
          if (idle !== true) {
            throw new Error(`scene ${scene.id}: wait-idle did not resolve true`);
          }
          break;
        }
        case 'wait-selector':
          await page.waitForSelector(step.selector, {
            state: 'visible',
            timeout: step.timeoutMs,
          });
          break;
        case 'wait-count':
          await page.waitForFunction(
            ({ selector, count }) => document.querySelectorAll(selector).length >= count,
            { selector: step.selector, count: step.count },
            { timeout: step.timeoutMs }
          );
          break;
        case 'assert-absent':
          if (await page.$(step.selector)) {
            throw new Error(`scene ${scene.id}: selector ${step.selector} must be absent`);
          }
          break;
        case 'pause':
          await page.waitForTimeout(step.ms);
          break;
        case 'press':
          await page.keyboard.press(step.key);
          break;
        case 'type': {
          const delays = typingDelays(step.text, step.delayMs || 0, step.seed);
          const chars = Array.from(step.text);
          for (let index = 0; index < chars.length; index += 1) {
            await page.keyboard.type(chars[index]);
            if (delays[index] > 0) {
              await page.waitForTimeout(delays[index]);
            }
          }
          break;
        }
        case 'move':
          await glideTo(step.selector, step.ms);
          break;
        case 'click': {
          const target = await centerOf(step.selector);
          const at = await page.evaluate(() => window.__demoPresentation.position());
          if (Math.hypot(target.x - at.x, target.y - at.y) > 3) {
            await glideTo(step.selector);
            await page.waitForTimeout(120);
          }
          await page.evaluate(() => window.__demoPresentation.press());
          await page.mouse.click(target.x, target.y);
          await page.waitForTimeout(140);
          break;
        }
        case 'scroll-to':
          await page.evaluate(({ selector, block, top }) => {
            const target = document.querySelector(selector);
            if (!target) {
              throw new Error(`scroll-to: ${selector} not found`);
            }
            if (typeof top === 'number') {
              // Scroll the element's nearest scrollable container (or itself).
              let container = target;
              while (container && container.scrollHeight <= container.clientHeight) {
                container = container.parentElement;
              }
              (container || document.scrollingElement).scrollTop = top;
              return;
            }
            target.scrollIntoView({ block: block || 'start', behavior: 'instant' });
          }, { selector: step.selector, block: step.block, top: step.top });
          break;
        case 'caption':
          await page.evaluate((text) => window.__demoPresentation.setCaption(text), step.text);
          break;
        case 'select-option': {
          // DOM-level so the control can be driven while its dialog is closed
          // (the palette reel picks the first palette in Quick Settings, then
          // cycles the rest with the chat unobscured); the real `change`
          // handler still runs.
          const changed = await page.evaluate(({ selector, value }) => {
            const select = document.querySelector(selector);
            if (!select || ![...select.options].some((option) => option.value === value)) {
              return false;
            }
            select.value = value;
            select.dispatchEvent(new Event('change', { bubbles: true }));
            return true;
          }, { selector: step.selector, value: step.value });
          if (!changed) {
            throw new Error(`scene ${scene.id}: select-option ${step.selector} has no option "${step.value}"`);
          }
          break;
        }
        default:
          throw new Error(
            `scene ${scene.id}: unknown step type "${step.type}" (expected one of ${STEP_TYPES.join(', ')})`
          );
      }
    }

    await page.screencast.stop();
    const recordedMs = Date.now() - recordStartedAt;
    const metaPath = path.join(outputDir, `${scene.outputBasename}.meta.json`);
    const metadata = {
      sceneId: scene.id,
      outputBasename: scene.outputBasename,
      leadInMs: scene.leadInMs,
      tailHoldMs: scene.tailHoldMs,
      recordedMs,
      width: captureWidth,
      height: captureHeight,
      viewport: { width, height },
      commit: currentCommit(),
      recordedAt: new Date().toISOString(),
    };
    fs.writeFileSync(metaPath, JSON.stringify(metadata, null, 2), 'utf8');
    console.log(`recorded ${scene.id} -> ${webmPath} (${recordedMs} ms)`);

    const recordedSeconds = recordedMs / 1000;
    if (recordedSeconds < scene.targetSeconds[0] || recordedSeconds > scene.targetSeconds[1]) {
      console.warn(
        `WARN scene ${scene.id}: ${recordedSeconds.toFixed(1)}s is outside target ${scene.targetSeconds[0]}-${scene.targetSeconds[1]}s`
      );
    }
    return { sceneId: scene.id, webmPath, metaPath, recordedMs };
  } finally {
    if (app) {
      try {
        await app.close();
      } catch (_error) {
        // Already closed.
      }
    }
    cleanupDemoProfile({ base });
  }
}

async function main() {
  assertScenesValid(DEMO_SCENES);
  const requestedIds = process.argv.slice(2);
  const validIds = DEMO_SCENES.map((scene) => scene.id);
  const unknownIds = requestedIds.filter((id) => !validIds.includes(id));
  if (unknownIds.length > 0) {
    console.error(`unknown scene id(s): ${unknownIds.join(', ')}; valid ids: ${validIds.join(', ')}`);
    return 1;
  }

  const scenes = requestedIds.length > 0
    ? DEMO_SCENES.filter((scene) => requestedIds.includes(scene.id))
    : DEMO_SCENES;
  const outputDir = process.env.JENNY_DEMO_OUTPUT_DIR || DEFAULT_OUTPUT_DIR;
  fs.mkdirSync(outputDir, { recursive: true });
  const failures = [];
  for (const scene of scenes) {
    try {
      await runScene(scene, { outputDir, readyTimeoutMs: DEFAULT_READY_TIMEOUT_MS });
    } catch (error) {
      const message = error && error.message ? error.message : String(error);
      failures.push({ id: scene.id, message });
      console.error(`failed ${scene.id}: ${message}`);
    }
  }

  console.log(`summary: ${scenes.length - failures.length}/${scenes.length} scene(s) recorded`);
  return failures.length === 0 ? 0 : 1;
}

module.exports = { runScene, DEFAULT_OUTPUT_DIR, scrubbedJennyEnv };

if (require.main === module) {
  main().then(
    (exitCode) => {
      process.exitCode = exitCode;
    },
    (error) => {
      console.error(`demo recording failed: ${error && error.message ? error.message : error}`);
      process.exitCode = 1;
    }
  );
}
