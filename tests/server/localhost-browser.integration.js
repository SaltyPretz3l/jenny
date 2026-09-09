'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { chromium } = require('playwright-core');

const { AuthService } = require('../../server/auth-service');
const { createHttpServer } = require('../../server/http-server');

const PASSWORD = 'test-password-strong';

function listen(server, port = 0) {
  return new Promise((resolve, reject) => {
    const onError = (error) => { server.off('listening', onListening); reject(error); };
    const onListening = () => { server.off('error', onError); resolve(server.address().port); };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, '127.0.0.1');
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

test('real Chromium localhost HTTP login, reload, logout and isolated cookie', {
  timeout: 120_000,
}, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-localhost-browser-'));
  const staticRoot = path.join(root, 'browser');
  const profileRoot = path.join(root, 'profile');
  fs.mkdirSync(staticRoot);
  fs.mkdirSync(profileRoot, { mode: 0o700 });
  for (const [name, body] of [['index.html', '<!doctype html><title>Jenny</title>'], ['app.js', ''], ['styles.css', '']]) {
    fs.writeFileSync(path.join(staticRoot, name), body, { mode: 0o600 });
  }

  let probe;
  let transport;
  let browser;
  try {
    probe = http.createServer();
    const port = await listen(probe);
    await closeServer(probe);
    probe = null;
    const origin = `http://127.0.0.1:${port}`;
    const auth = new AuthService({ filePath: path.join(profileRoot, 'auth.json') });
    assert.equal((await auth.initializePassword(PASSWORD)).ok, true);
    const clients = { register: () => null };
    const events = { heartbeat() {} };
    transport = createHttpServer({
      canonicalOrigin: origin,
      browserAccessMode: 'localhost_http',
      staticRoot,
      auth,
      clients,
      events,
      router: {},
      bootEpoch: 'localhost-browser',
      isReady: () => true,
      executionStatus: () => false,
    });
    await listen(transport.server, port);
    browser = await chromium.launch({
      headless: true,
      executablePath: process.env.JENNY_CHROMIUM_EXECUTABLE || chromium.executablePath(),
      args: process.platform === 'linux' ? ['--no-sandbox'] : [],
    });
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(`${origin}/`, { waitUntil: 'domcontentloaded' });

    const login = await page.evaluate(async (password) => {
      const response = await fetch('/api/v1/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      });
      return { status: response.status, body: await response.json() };
    }, PASSWORD);
    assert.equal(login.status, 200);
    const cookies = await context.cookies(origin);
    assert.deepEqual(cookies.map((cookie) => cookie.name), ['jenny-localhost']);
    assert.equal(cookies[0].secure, false);
    assert.equal(cookies[0].httpOnly, true);
    assert.equal(cookies[0].sameSite, 'Strict');
    assert.equal(cookies[0].path, '/');
    assert.equal(login.body.token, undefined);

    await page.reload({ waitUntil: 'domcontentloaded' });
    const bootstrap = await page.evaluate(async () => {
      const response = await fetch('/api/v1/bootstrap');
      return { status: response.status, body: await response.json() };
    });
    assert.equal(bootstrap.status, 200);
    assert.equal(bootstrap.body.csrf_token, login.body.csrf_token);

    const logout = await page.evaluate(async (csrfToken) => {
      const response = await fetch('/api/v1/auth/logout', {
        method: 'POST', headers: { 'X-CSRF-Token': csrfToken },
      });
      return response.status;
    }, login.body.csrf_token);
    assert.equal(logout, 200);
    await page.waitForTimeout(50);
    assert.deepEqual(await context.cookies(origin), []);
    const denied = await page.evaluate(async () => (await fetch('/api/v1/bootstrap')).status);
    assert.equal(denied, 401);
    await context.close();
  } finally {
    await browser?.close();
    await transport?.close();
    await closeServer(probe);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
