'use strict';

// Real-browser localhost sandbox proof. The parent packaging lane starts the
// host and model containers, then invokes this script with a disposable test
// password. Keep diagnostics generic: this probe must not echo prompts,
// cookies, model keys, or tool output.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');
const { chromium } = require('playwright-core');

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_TIMEOUT_MS = 120_000;
const COOKIE_NAME = 'jenny-localhost';

function parsePort(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('probe port must be an integer between 1 and 65535');
  }
  return port;
}

function parseArgs(argv) {
  const values = argv.slice(2);
  let host = process.env.JENNY_PROBE_HOST || DEFAULT_HOST;
  let rawPort = process.env.JENNY_PROBE_PORT || '';
  let password = process.env.JENNY_PROBE_PASSWORD || '';
  if (values.length >= 3) {
    [host, rawPort, password] = values;
  } else if (values.length === 2) {
    [rawPort, password] = values;
  } else if (values.length === 1) {
    [rawPort] = values;
  }
  if (!/^[A-Za-z0-9.-]+$/u.test(host) || host.length > 253) {
    throw new Error('probe host is invalid');
  }
  if (!password || password.length > 4096) throw new Error('probe password is required');
  const port = parsePort(rawPort);
  return { host, port, password, origin: `http://${host}:${port}` };
}

async function waitForState(page, predicate, arg, timeout = 30_000) {
  await page.waitForFunction(predicate, arg, { timeout });
}

async function readState(page) {
  return page.evaluate(() => {
    const state = globalThis.jennyHostedApp?.state;
    const snapshot = state?.snapshot;
    return {
      sessionId: state?.selectedSessionId || '',
      activeStreamId: state?.activeStreamId || '',
      snapshot: snapshot ? structuredClone(snapshot) : null,
    };
  });
}

function snapshotMessages(state) {
  return Array.isArray(state?.snapshot?.messages) ? state.snapshot.messages : [];
}

function messageIds(state) {
  return new Set(snapshotMessages(state).map((message) => String(message?.id || '')));
}

function newMessages(state, baselineIds) {
  return snapshotMessages(state).filter((message) => !baselineIds.has(String(message?.id || '')));
}

function toolResults(messages) {
  return messages.map((message) => message?.tool_result).filter((result) => (
    result && typeof result === 'object' && !Array.isArray(result)
  ));
}

async function waitForTurnTerminal(page, baselineIds) {
  await waitForState(page, (ids) => {
    const state = globalThis.jennyHostedApp?.state;
    const snapshot = state?.snapshot;
    const messages = Array.isArray(snapshot?.messages) ? snapshot.messages : [];
    const seen = new Set(ids);
    return Boolean(snapshot && !snapshot.active_turn && !state.activeStreamId
      && (!Array.isArray(snapshot.pending_approvals) || snapshot.pending_approvals.length === 0)
      && messages.some((message) => !seen.has(String(message?.id || ''))));
  }, [...baselineIds], DEFAULT_TIMEOUT_MS);
  return readState(page);
}

async function sendUntilApproval(page, prompt, baselineIds) {
  const beforeOutputs = await page.locator('.browser-tool-output').count();
  await page.locator('#composer-prompt').fill(prompt);
  await page.locator('[data-action="send-chat"]').click();
  await waitForState(page, (ids) => {
    const snapshot = globalThis.jennyHostedApp?.state?.snapshot;
    const messages = Array.isArray(snapshot?.messages) ? snapshot.messages : [];
    const seen = new Set(ids);
    return Array.isArray(snapshot?.pending_approvals) && snapshot.pending_approvals.length > 0
      && messages.some((message) => !seen.has(String(message?.id || '')));
  }, [...baselineIds], DEFAULT_TIMEOUT_MS);
  return beforeOutputs;
}

async function resolveApproval(page, action) {
  const selector = `[data-action="${action}-tool"]`;
  await page.locator(selector).last().waitFor({ state: 'visible', timeout: 30_000 });
  await page.locator(selector).last().click();
}

async function runApprove(page, baselineState) {
  const baselineIds = messageIds(baselineState);
  const beforeOutputs = await sendUntilApproval(page, 'sandbox approve', baselineIds);
  // The tool must remain pending until the explicit approval click.
  await page.waitForTimeout(400);
  assert.equal(await page.locator('.browser-tool-output').count(), beforeOutputs);
  await resolveApproval(page, 'approve');
  const finalState = await waitForTurnTerminal(page, baselineIds);
  const messages = newMessages(finalState, baselineIds);
  const outputs = toolResults(messages).map((result) => String(result.output_text || ''));
  assert(outputs.some((output) => output.includes('sandbox-proof')),
    'approved sandbox command did not produce the fixture proof: ' + JSON.stringify(messages.map((message) => ({
      role: message.role, kind: message.kind, status: message.status,
      tool: message.tool_result?.tool_name, error: message.tool_result?.error_code,
      outputLength: String(message.tool_result?.output_text || '').length,
    }))));
  return finalState;
}

async function runDeny(page, baselineState) {
  const baselineIds = messageIds(baselineState);
  await sendUntilApproval(page, 'sandbox deny', baselineIds);
  await resolveApproval(page, 'deny');
  const finalState = await waitForTurnTerminal(page, baselineIds);
  const results = toolResults(newMessages(finalState, baselineIds));
  assert(results.length > 0, 'denied sandbox command did not produce a terminal tool result');
  assert(results.every((result) => String(result.output_text || '').includes('sandbox-denied-marker') === false),
    'denied sandbox command exposed a command result');
  return finalState;
}

async function runCancel(page, baselineState) {
  const baselineIds = messageIds(baselineState);
  await sendUntilApproval(page, 'sandbox cancel', baselineIds);
  await resolveApproval(page, 'approve');
  await page.locator('[data-action="cancel-chat"]').waitFor({ state: 'visible', timeout: 30_000 });
  const appContainer = process.env.JENNY_PROBE_APP_CONTAINER;
  assert.ok(appContainer && /^[a-f0-9]{12,64}$/u.test(appContainer), 'test app container identity required');
  let running = false;
  for (let i = 0; i < 50; i++) {
    const status = execFileSync('docker', ['exec', appContainer, 'node', '-e',
      "require('./services/host/worker-transport').requestWorker('status').then(s=>process.stdout.write(s.phase))"], { encoding: 'utf8', timeout: 8000, windowsHide: true });
    if (status === 'running') { running = true; break; }
    await delay(100);
  }
  assert.ok(running, 'cancel proof requires an admitted worker job');
  const cancelStartedAt = Date.now();
  await page.locator('[data-action="cancel-chat"]').click();
  const finalState = await waitForTurnTerminal(page, baselineIds);
  assert(Date.now() - cancelStartedAt >= 8_000, 'sandbox cancellation settled before worker cleanup window');
  const messages = newMessages(finalState, baselineIds);
  assert(messages.some((message) => /cancel/u.test([
    message?.status, message?.terminal_subcode, message?.content,
  ].map((value) => String(value || '')).join(' '))), 'sandbox cancellation did not reach a cancelled terminal state');
  return finalState;
}

async function login(page, password) {
  await page.locator('#login-password').fill(password);
  await page.locator('[data-action="login-submit"]').click();
  await page.locator('[data-browser-app]').waitFor({ state: 'visible', timeout: 30_000 });
  await waitForState(page, () => globalThis.jennyHostedApp?.state?.connectionState === 'connected', null, 30_000);
}

async function main() {
  const { origin, password } = parseArgs(process.argv);
  const executablePath = process.env.JENNY_CHROMIUM_EXECUTABLE || chromium.executablePath();
  if (!fs.existsSync(executablePath)) throw new Error('Chromium executable is missing');
  const browser = await chromium.launch({
    headless: true,
    executablePath,
    args: process.platform === 'linux' ? ['--no-sandbox'] : [],
  });
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    await page.goto(`${origin}/`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await login(page, password);
    const cookies = await context.cookies(origin);
    const authCookies = cookies.filter((cookie) => cookie.name === COOKIE_NAME);
    assert.equal(authCookies.length, 1, 'localhost login did not issue the expected cookie');
    assert.equal(authCookies[0].httpOnly, true);
    assert.equal(authCookies[0].secure, false);
    assert.equal(authCookies[0].sameSite, 'Strict');
    assert.equal(authCookies[0].path, '/');
    assert.equal(cookies.some((cookie) => cookie.name === '__Host-jenny'), false);

    await page.locator('[data-action="new-session"]').click();
    const session = page.locator('[data-session-list] [data-session-id]').last();
    await session.waitFor({ state: 'visible', timeout: 30_000 });
    await page.locator('[data-action="acquire-control"]').click();
    await waitForState(page, () => {
      const button = globalThis.document.querySelector('[data-action="acquire-control"], [data-action="release-control"]');
      return button?.textContent?.trim() === 'Release control' && button.disabled === false;
    }, null, 30_000);

    const approved = await runApprove(page, await readState(page));
    await runDeny(page, approved);
    await runCancel(page, await readState(page));

    await page.reload({ waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page.locator('[data-browser-app]').waitFor({ state: 'visible', timeout: 30_000 });
    await waitForState(page, () => {
      const state = globalThis.jennyHostedApp?.state;
      return state?.connectionState === 'connected'
        && Boolean(state.selectedSessionId)
        && Array.isArray(state.snapshot?.messages)
        && state.snapshot.messages.some((message) => String(message?.content || '').includes('sandbox-proof'));
    }, null, 30_000);
    console.log('localhost sandbox browser probe passed');
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`localhost sandbox browser probe failed: ${error?.message || 'unknown error'}`);
    process.exitCode = 1;
  });
}

module.exports = Object.freeze({
  parseArgs,
  parsePort,
  snapshotMessages,
});
