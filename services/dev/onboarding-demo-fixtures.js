'use strict';

/**
 * services/dev/onboarding-demo-fixtures.js
 *
 * DEV-ONLY scaffolding for a manual, end-to-end walkthrough of the guided
 * first-run onboarding flow WITHOUT any real download or installation.
 *
 * Activated ONLY when JENNY_ONBOARDING_DEMO=1 (set by
 * scripts/dev/run-onboarding-demo.js). When the flag is unset,
 * applyOnboardingDemo() is never called and the production services are
 * byte-for-byte unchanged.
 *
 * The HARDWARE SCAN runs for REAL (offline.getDiagnostics -> the live sidecar),
 * so you see your actual GPU / VRAM / RAM and the real ranked recommendations.
 * Only the destructive leaves are replaced with paced in-memory fakes:
 *   - setup.detectOllama      -> "not installed" (so the opt-in path renders)
 *   - setup.startOllamaPull   -> fake `ollama pull` subprocess (scripted stdout)
 *   - ollama install download -> paced fake byte stream (real SHA256 check passes)
 *   - ollama install spawn     -> fake installer that exits 0
 *
 * Nothing touches the network, spawns a real subprocess, or pulls a model.
 */

const crypto = require('crypto');
const { EventEmitter } = require('events');

function isOnboardingDemo(env = process.env) {
  return /^(1|true|yes|on)$/i.test(String((env && env.JENNY_ONBOARDING_DEMO) || '').trim());
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---- fake installer download (real SHA256 check still runs) ----------------

// Deterministic payload whose SHA256 we pin into the demo manifest, so the REAL
// fail-closed integrity check in OllamaInstallService passes against the stream.
const DEMO_DOWNLOAD_CHUNK = Buffer.alloc(4096, 0x7a); // 'z'
const DEMO_DOWNLOAD_CHUNKS = 20;
const DEMO_DOWNLOAD = Buffer.concat(
  Array.from({ length: DEMO_DOWNLOAD_CHUNKS }, () => DEMO_DOWNLOAD_CHUNK)
);
const DEMO_DOWNLOAD_SHA256 = crypto.createHash('sha256').update(DEMO_DOWNLOAD).digest('hex');

function demoInstallManifest() {
  return {
    source: 'demo-fixture',
    url: 'https://example.test/demo/OllamaSetup.exe',
    version: '0.0.0-demo',
    // Cosmetic label only ("Download & install Ollama (0.7 GB)"); the faked
    // stream is tiny and drives the bar from its honest content-length.
    sizeBytes: 700 * 1024 * 1024,
    sha256: DEMO_DOWNLOAD_SHA256,
    license: 'MIT',
    manualFallbackUrl: 'https://ollama.com/download/windows',
  };
}

// Streams the demo payload in paced slices with an honest content-length so the
// REAL _download() percent climbs 0 -> 100 over ~3s.
function demoDownloadFetch() {
  return async function fakeDownloadFetch() {
    async function* body() {
      for (let i = 0; i < DEMO_DOWNLOAD_CHUNKS; i += 1) {
        await sleep(150);
        yield DEMO_DOWNLOAD_CHUNK;
      }
    }
    return {
      ok: true,
      status: 200,
      headers: {
        get: (name) => (String(name).toLowerCase() === 'content-length'
          ? String(DEMO_DOWNLOAD.length)
          : null),
      },
      body: body(),
    };
  };
}

// Fake installer process: resolves exit code 0 after a short pause.
function demoInstallerSpawn() {
  return function fakeInstallerSpawn() {
    const child = new EventEmitter();
    child.kill = () => {};
    setTimeout(() => child.emit('exit', 0), 600);
    return child;
  };
}

// detectImpl for the install service: "not installed" on the first call (the
// pre-download already-installed check), "installed" afterwards (the re-probe),
// so the lifecycle runs end-to-end and reports success.
function demoInstallDetect() {
  let calls = 0;
  return async function fakeInstallDetect() {
    calls += 1;
    const installed = calls > 1;
    return { installed, running: installed, version: installed ? '0.0.0-demo' : '' };
  };
}

// ---- fake `ollama pull` subprocess (drives the REAL stdout parser) ---------

function demoPullSpawn() {
  return function fakePullSpawn() {
    const child = new EventEmitter();
    const stdout = new EventEmitter();
    const stderr = new EventEmitter();
    child.stdout = stdout;
    child.stderr = stderr;

    const digest = 'a1b2c3d4e5f6';
    const lines = ['pulling manifest'];
    for (const pct of [8, 18, 30, 44, 58, 70, 82, 91, 97, 100]) {
      const doneMb = Math.round((pct / 100) * 1200);
      lines.push(`pulling ${digest}  ${pct}% ${doneMb} MB/1.2 GB`);
    }
    lines.push('verifying sha256 digest', 'writing manifest', 'success');

    let i = 0;
    let timer = null;
    const stop = () => {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    };
    child.kill = stop;
    timer = setInterval(() => {
      if (i >= lines.length) {
        stop();
        child.emit('exit', 0, null);
        return;
      }
      stdout.emit('data', Buffer.from(`${lines[i]}\n`));
      i += 1;
    }, 250);
    return child;
  };
}

// ---- application ----------------------------------------------------------

let bannerShown = false;

/**
 * Decorate the already-constructed services in place. The hardware scan
 * (offline.getDiagnostics) is intentionally left untouched so it runs for real.
 */
function applyOnboardingDemo(services = {}) {
  const { setupService, ollamaInstallService } = services;

  if (setupService) {
    setupService.detectOllama = async () => ({
      installed: false, running: false, version: '', installPath: '', source: 'demo',
    });
    setupService.spawnImpl = demoPullSpawn();
  }
  if (ollamaInstallService) {
    ollamaInstallService.manifest = demoInstallManifest();
    ollamaInstallService.fetchImpl = demoDownloadFetch();
    ollamaInstallService.spawnImpl = demoInstallerSpawn();
    ollamaInstallService.detectImpl = demoInstallDetect();
    ollamaInstallService.delayImpl = (ms) => sleep(Math.min(Number(ms) || 0, 300));
  }

  if (!bannerShown) {
    bannerShown = true;
    // Main-process stdout is inherited by the launcher terminal.
    console.warn(
      '[onboarding-demo] ACTIVE — real hardware scan; Ollama detect/install/pull are FAKED. '
      + 'No network, no subprocess, no model download.'
    );
  }
}

module.exports = {
  isOnboardingDemo,
  applyOnboardingDemo,
  demoInstallManifest,
  DEMO_DOWNLOAD_SHA256,
};
