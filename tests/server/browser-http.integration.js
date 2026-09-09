'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');
const { chromium } = require('playwright-core');

const { createHttpServer } = require('../../server/http-server');
const { AuthService } = require('../../server/auth-service');
const { ClientRegistry } = require('../../server/client-registry');
const { ControlLeases } = require('../../server/control-leases');
const { CommandReceipts } = require('../../server/command-receipts');
const { BackendEvents } = require('../../server/backend-events');
const { createCommandRouter } = require('../../server/command-router');
const { createHostedBackend } = require('../../services/host/service-composition');
const { createTestCertificate } = require('./helpers/browser-test-certificate');

const PASSWORD = 'test-password-strong';
const REPLAY_TEXT = 'Paced browser replay response is visible while the real hosted stream is still active and remains canonical after reconnect.';
const BROWSER_ROOT = path.resolve(__dirname, '../../build/browser');

function listen(server) {
  return new Promise((resolve, reject) => {
    const onError = (error) => { server.off('listening', onListening); reject(error); };
    const onListening = () => { server.off('error', onError); resolve(server.address().port); };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(0, '127.0.0.1');
  });
}

async function closeServer(server) {
  if (!server) return;
  server.closeAllConnections?.();
  await new Promise((resolve, reject) => server.close((error) => {
    if (error && error.code !== 'ERR_SERVER_NOT_RUNNING') reject(error);
    else resolve();
  }));
}

async function runCleanup(steps) {
  const failures = [];
  for (const [label, cleanup] of steps) {
    try { await cleanup(); }
    catch (error) { failures.push(new Error(`${label} cleanup failed.`, { cause: error })); }
  }
  return failures;
}

function writeReplayScript(directory) {
  const scriptPath = path.join(directory, 'browser-replay.json');
  fs.writeFileSync(scriptPath, JSON.stringify({ version: 1, calls: [{ text: REPLAY_TEXT }] }), {
    encoding: 'utf8', mode: 0o600,
  });
  return scriptPath;
}

function createCredentialService() {
  return Object.freeze({ get: () => '', getStatus: () => ({ ready: true }) });
}

async function createFixture() {
  for (const file of ['index.html', 'app.js', 'styles.css']) {
    assert.equal(fs.statSync(path.join(BROWSER_ROOT, file)).isFile(), true,
      `Run npm run build:browser before this integration test (${file}).`);
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-browser-http-'));
  fs.chmodSync(root, 0o700);
  const userDataPath = path.join(root, 'profile');
  fs.mkdirSync(userDataPath, { mode: 0o700 });
  const replayScript = writeReplayScript(root);
  const previousReplayScript = process.env.JENNY_REPLAY_SCRIPT;
  const previousReplayDelay = process.env.JENNY_REPLAY_DELAY_MS;
  process.env.JENNY_REPLAY_SCRIPT = replayScript;
  process.env.JENNY_REPLAY_DELAY_MS = '80';

  let composition;
  let transport;
  let proxy;
  let router;
  let events;
  let certificate;
  let closed = false;
  const restoreEnvironment = () => {
    if (previousReplayScript === undefined) delete process.env.JENNY_REPLAY_SCRIPT;
    else process.env.JENNY_REPLAY_SCRIPT = previousReplayScript;
    if (previousReplayDelay === undefined) delete process.env.JENNY_REPLAY_DELAY_MS;
    else process.env.JENNY_REPLAY_DELAY_MS = previousReplayDelay;
  };
  const cleanup = async () => {
    if (closed) return [];
    closed = true;
    return runCleanup([
      ['HTTPS proxy', () => closeServer(proxy)],
      ['HTTP transport', () => transport?.close?.()],
      ['command router', () => router?.dispose?.()],
      ['backend events', () => events?.dispose?.()],
      ['host stop', () => composition?.stop?.()],
      ['host dispose', () => composition?.dispose?.()],
      ['certificate', () => certificate?.cleanup?.()],
      ['profile', () => fs.rmSync(root, { recursive: true, force: true })],
      ['replay environment', restoreEnvironment],
    ]);
  };
  try {
    const pythonExecutable = process.env.JENNY_TEST_PYTHON || path.resolve('.venv',
      process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
    assert.equal(fs.existsSync(pythonExecutable), true, 'Test Python runtime must be provisioned.');
    composition = createHostedBackend({
      hostMode: 'server',
      userDataPath,
      workspaceRoot: null,
      repoRoot: path.resolve(__dirname, '../..'),
      pythonExecutable,
      modelEndpoint: { engine: 'replay', model: 'browser-replay' },
      credentialService: createCredentialService(),
    });
    const managedConfig = composition.backend._buildManagedSidecarConfig();
    assert.equal(managedConfig.feature_flags?.multiplexer, true);
    assert.equal(managedConfig.feature_flags?.chat_cancel, true);
    await composition.start();

    const clients = new ClientRegistry();
    const leases = new ControlLeases();
    const bootEpoch = 'browser_boot';
    events = new BackendEvents({ backend: composition.backend, bootEpoch });
    const auth = new AuthService({ filePath: path.join(userDataPath, 'auth.json'), onInvalidate: (id) => {
      clients.revokeDevice(id);
      leases.revokeDevice(id);
      events.revokeDevice(id);
    } });
    assert.equal((await auth.initializePassword(PASSWORD)).ok, true);
    router = createCommandRouter({
      backend: composition.backend,
      clients,
      leases,
      receipts: new CommandReceipts({ filePath: path.join(userDataPath, 'command-receipts.json') }),
      bootEpoch,
      eventStream: events,
    });

    let upstreamPort = 0;
    let proxyPort = 0;
    certificate = createTestCertificate();
    proxy = https.createServer({ key: certificate.key, cert: certificate.certificate }, (request, response) => {
      if (!upstreamPort) {
        response.destroy();
        return;
      }
      const headers = { ...request.headers, host: `localhost:${proxyPort}` };
      delete headers.connection;
      delete headers['proxy-connection'];
      const upstream = http.request({
        hostname: '127.0.0.1', port: upstreamPort, path: request.url,
        method: request.method, headers, agent: false,
      }, (upstreamResponse) => {
        if (response.destroyed) {
          upstream.destroy();
          return;
        }
        response.writeHead(upstreamResponse.statusCode || 502, upstreamResponse.headers);
        upstreamResponse.pipe(response);
      });
      const closeUpstream = () => { if (!upstream.destroyed) upstream.destroy(); };
      response.once('close', closeUpstream);
      upstream.once('close', () => response.off('close', closeUpstream));
      upstream.once('error', (error) => {
        if (!response.headersSent) response.writeHead(502);
        response.destroy(error);
      });
      request.pipe(upstream);
    });
    proxyPort = await listen(proxy);
    const canonicalOrigin = `https://localhost:${proxyPort}`;
    transport = createHttpServer({
      canonicalOrigin,
      staticRoot: BROWSER_ROOT,
      auth,
      clients,
      events,
      router,
      bootEpoch,
      isReady: () => true,
    });
    upstreamPort = await listen(transport.server);

    return {
      origin: canonicalOrigin,
      composition,
      close: async () => {
        const failures = await cleanup();
        if (failures.length) throw new AggregateError(failures, 'Browser fixture cleanup failed.');
      },
    };
  } catch (error) {
    const failures = await cleanup();
    if (failures.length) error.cleanupErrors = failures;
    throw error;
  }
}

async function waitForText(page, selector, expected, timeout = 30_000) {
  await page.waitForFunction(({ target, value }) => {
    const element = globalThis.document.querySelector(target);
    return Boolean(element && element.textContent.includes(value));
  }, { target: selector, value: expected }, { timeout });
}

function assertMemoryOnlyCredentials(context) {
  return context.cookies().then((cookies) => {
    const authCookies = cookies.filter((cookie) => cookie.name === '__Host-jenny');
    assert.equal(authCookies.length, 1);
    assert.equal(authCookies[0].secure, true);
    assert.equal(authCookies[0].httpOnly, true);
    return authCookies[0].value;
  });
}

test('real HTTPS browser contexts login, share replay history, and reconnect from cookies', {
  timeout: 120_000,
}, async () => {
  const fixture = await createFixture();
  let browser;
  let contextA;
  let contextB;
  let failure = null;
  try {
    const executablePath = process.env.JENNY_CHROMIUM_EXECUTABLE || chromium.executablePath();
    assert.equal(fs.existsSync(executablePath), true, `Chromium executable is missing: ${executablePath}`);
    browser = await chromium.launch({
      headless: true,
      executablePath,
      args: process.platform === 'linux' ? ['--no-sandbox'] : [],
    });
    contextA = await browser.newContext({ ignoreHTTPSErrors: true });
    contextB = await browser.newContext({ ignoreHTTPSErrors: true });
    const pageA = await contextA.newPage();
    const pageB = await contextB.newPage();
    await pageA.goto(`${fixture.origin}/`, { waitUntil: 'domcontentloaded' });
    await pageA.locator('#login-password').fill(PASSWORD);
    await pageA.locator('[data-action="login-submit"]').click();
    await pageA.locator('[data-browser-app]').waitFor({ state: 'visible', timeout: 15_000 });
    await pageA.locator('[data-action="new-session"]').waitFor({ state: 'visible', timeout: 15_000 });
    const cookieA = await assertMemoryOnlyCredentials(contextA);
    assert.deepEqual(await pageA.evaluate(() => Object.keys(globalThis.localStorage)), []);

    await pageA.locator('[data-action="new-session"]').click();
    const sessionRowA = pageA.locator('[data-session-list] [data-session-id]').first();
    await sessionRowA.waitFor({ state: 'visible', timeout: 15_000 });
    const sessionId = await sessionRowA.getAttribute('data-session-id');
    assert.match(sessionId, /^[A-Za-z0-9_-]{1,128}$/);
    await pageA.locator('[data-action="acquire-control"]').waitFor({ state: 'visible', timeout: 15_000 });
    await pageA.locator('[data-action="acquire-control"]').click();
    await pageA.waitForFunction(() => {
      const button = globalThis.document.querySelector('[data-action="acquire-control"], [data-action="release-control"]');
      return button?.textContent.trim() === 'Release control' && button.disabled === false;
    }, null, { timeout: 15_000 });

    await pageB.goto(`${fixture.origin}/`, { waitUntil: 'domcontentloaded' });
    await pageB.locator('#login-password').fill(PASSWORD);
    await pageB.locator('[data-action="login-submit"]').click();
    await pageB.locator('[data-browser-app]').waitFor({ state: 'visible', timeout: 15_000 });
    await pageB.locator(`[data-session-list] > .browser-session[data-session-id="${sessionId}"]`).waitFor({ state: 'visible', timeout: 15_000 });
    await pageB.waitForFunction(() => {
      const button = globalThis.document.querySelector('[data-action="acquire-control"], [data-action="release-control"]');
      const prompt = globalThis.document.querySelector('#composer-prompt');
      return button?.textContent.trim() === 'Take over'
        && button.dataset.takeover === 'true' && prompt?.disabled === true;
    }, null, { timeout: 15_000 });
    await pageB.waitForFunction(() => globalThis.document.querySelector('[data-browser-connection]')?.textContent === 'Connected', null, { timeout: 15_000 });
    const deniedAcquire = await pageB.evaluate(async (id) => {
      try {
        return await globalThis.jennyHostedApp.bridge.command('control.acquire', {
          sessionId: id, params: { takeover: false },
        });
      } catch (error) {
        return { ok: false, error: error.payload?.error || { code: error.code, reason: error.message } };
      }
    }, sessionId);
    assert.equal(deniedAcquire.ok, false);
    assert.equal(deniedAcquire.error.reason, 'control_lease_unavailable');
    assert.equal(await pageB.locator('#composer-prompt').isDisabled(), true);
    const cookieB = await assertMemoryOnlyCredentials(contextB);
    assert.notEqual(cookieA, cookieB);
    assert.deepEqual(await pageB.evaluate(() => Object.keys(globalThis.localStorage)), []);

    await pageA.locator('#composer-prompt').fill('Please answer using the deterministic browser replay.');
    await pageA.locator('[data-action="send-chat"]').click();
    await waitForText(pageB, '[data-live]', 'Paced browser replay response', 15_000);
    await waitForText(pageA, '[data-transcript]', REPLAY_TEXT);
    await pageA.locator('[data-action="send-chat"]').waitFor({ state: 'visible', timeout: 30_000 });
    await waitForText(pageB, '[data-transcript]', REPLAY_TEXT);

    const controlButton = pageA.locator('[data-action="acquire-control"], [data-action="release-control"]');
    await controlButton.click();
    await pageA.waitForFunction(() => {
      const prompt = globalThis.document.querySelector('#composer-prompt');
      const button = globalThis.document.querySelector('[data-action="acquire-control"]');
      return button?.textContent.trim() === 'Take control' && prompt?.disabled === true;
    }, null, { timeout: 15_000 });
    await controlButton.click();
    await pageA.waitForFunction(() => {
      const prompt = globalThis.document.querySelector('#composer-prompt');
      const button = globalThis.document.querySelector('[data-action="acquire-control"], [data-action="release-control"]');
      return button?.textContent.trim() === 'Release control' && prompt?.disabled === false;
    }, null, { timeout: 15_000 });

    const takeoverButton = pageB.locator('[data-action="acquire-control"], [data-action="release-control"]');
    await takeoverButton.click();
    await pageB.waitForFunction(() => {
      const prompt = globalThis.document.querySelector('#composer-prompt');
      const button = globalThis.document.querySelector('[data-action="acquire-control"], [data-action="release-control"]');
      return button?.textContent.trim() === 'Release control' && prompt?.disabled === false;
    }, null, { timeout: 15_000 });
    await pageA.waitForFunction(() => {
      const prompt = globalThis.document.querySelector('#composer-prompt');
      const button = globalThis.document.querySelector('[data-action="acquire-control"], [data-action="release-control"]');
      return button?.textContent.trim() === 'Take over'
        && button.dataset.takeover === 'true' && prompt?.disabled === true;
    }, null, { timeout: 15_000 });

    await pageB.locator('#composer-prompt').fill('Continue the deterministic browser replay from the second device.');
    await pageB.locator('[data-action="send-chat"]').click();
    await waitForText(pageA, '[data-live]', 'Paced browser replay response', 15_000);
    await pageB.waitForFunction(() => globalThis.document.querySelectorAll('.browser-row--assistant_text').length >= 2, null, { timeout: 30_000 });
    await pageB.locator('[data-action="send-chat"]').waitFor({ state: 'visible', timeout: 30_000 });
    const canonical = await fixture.composition.backend.getSessionMessages(sessionId);
    assert.equal(canonical.data.filter((message) => message.role === 'assistant' && message.content).length, 2);
    assert.equal(canonical.data.filter((message) => message.role === 'user' && message.content).length, 2);

    await pageB.reload({ waitUntil: 'domcontentloaded' });
    await pageB.locator('[data-browser-app]').waitFor({ state: 'visible', timeout: 15_000 });
    await pageB.locator(`[data-session-list] > .browser-session[data-session-id="${sessionId}"]`).waitFor({ state: 'visible', timeout: 15_000 });
    await waitForText(pageB, '[data-transcript]', REPLAY_TEXT);
    await pageB.waitForFunction(() => globalThis.document.querySelector('[data-browser-connection]')?.textContent === 'Connected', null, { timeout: 15_000 });
    assert.deepEqual(await pageB.evaluate(() => Object.keys(globalThis.localStorage)), []);
  } catch (error) {
    failure = error;
  } finally {
    const cleanupErrors = await runCleanup([
      ['browser context B', () => contextB?.close?.()],
      ['browser context A', () => contextA?.close?.()],
      ['Chromium', () => browser?.close?.()],
      ['fixture', () => fixture.close()],
    ]);
    if (cleanupErrors.length) {
      if (failure) failure.cleanupErrors = cleanupErrors;
      else failure = new AggregateError(cleanupErrors, 'Browser test cleanup failed.');
    }
  }
  if (failure) throw failure;
});
