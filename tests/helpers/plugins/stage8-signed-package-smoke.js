'use strict';
/* global document, window */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// The descriptor probe and the post-commit hook launch each raise their own
// consent window, so a signed V6 acceptance run expects two hook approvals.
// That count was pinned independently in three places -- two defaults and one
// bare `>= 2` -- so a legitimate change to the launch count could update one
// and leave the owner-only flow internally inconsistent.
const REQUIRED_CONFORMANCE_HOOK_LAUNCHES = 2;
const PUBLISHER_ID = 'jenny-official';
const PLUGIN_ID = 'stage8-conformance';
const CONTRIBUTION_KINDS = Object.freeze([
  'engine_adapter',
  'hook',
  'native_mcp',
  'session_provider',
]);

function assertSignedPackage(signedPackage) {
  assert.equal(path.extname(signedPackage).toLowerCase(), '.jenny-plugin');
  assert.ok(fs.statSync(signedPackage).isFile(), 'signed V6 fixture must be a regular file');
}

function readJsonIfPresent(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_error) {
    return null;
  }
}

function readJsonDirectory(directoryPath) {
  try {
    return fs.readdirSync(directoryPath)
      .filter((name) => name.endsWith('.json'))
      .sort()
      .map((name) => readJsonIfPresent(path.join(directoryPath, name)));
  } catch (_error) {
    return [];
  }
}

function readStoreEvidence(profile) {
  const pluginRoot = path.join(profile, 'plugins');
  return {
    active_pointer: readJsonIfPresent(path.join(pluginRoot, 'active-generation.json')),
    migration: readJsonIfPresent(path.join(
      pluginRoot, 'provider-migrations', 'chatgpt-subscription.json'
    )),
    receipts: readJsonDirectory(path.join(pluginRoot, 'operations')),
  };
}

function readConsentApprovals(profile) {
  try {
    return fs.readFileSync(path.join(profile, 'logs', 'shell.log'), 'utf8')
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .filter((entry) => entry.event === 'plugins.consent_window_settled'
        && entry.details?.status === 'approved'
        && entry.details?.acknowledged === true)
      .map((entry) => String(entry.details?.contribution_id || ''))
      .filter(Boolean);
  } catch (_error) {
    return [];
  }
}

function consentEvidenceComplete(approved, hookCount) {
  const kinds = new Set(approved.map((item) => item.replace(/^conformance_/, '')));
  return CONTRIBUTION_KINDS.every((kind) => kinds.has(kind))
    && approved.filter((item) => item === 'conformance_hook').length >= hookCount;
}

async function waitForConsentApprovals(profile, { since = 0, hookCount = REQUIRED_CONFORMANCE_HOOK_LAUNCHES } = {}) {
  const deadline = Date.now() + 15_000;
  let approved;
  do {
    approved = readConsentApprovals(profile).slice(since);
    if (consentEvidenceComplete(approved, hookCount)) return approved;
    await new Promise((resolve) => setTimeout(resolve, 50));
  } while (Date.now() < deadline);
  assert.fail(`signed V6 consent evidence incomplete: ${JSON.stringify(approved)}`);
}

async function pluginState(page) {
  const state = await page.evaluate(() => window.jennyShell.plugins.getState({}));
  return {
    state,
    plugin: state.plugins?.find((item) => (
      item.publisher_id === PUBLISHER_ID && item.plugin_id === PLUGIN_ID
    )) || null,
  };
}

async function waitForPlugin(page, predicate, description) {
  const deadline = Date.now() + 30_000;
  let snapshot;
  do {
    snapshot = await pluginState(page);
    if (snapshot.plugin && predicate(snapshot.plugin, snapshot.state)) return snapshot;
    const rendererError = await page.evaluate(() => (
      document.querySelector('[data-plugins-last-error]')?.textContent || ''
    ));
    if (rendererError) {
      assert.fail(`${description}: ${rendererError}; ${JSON.stringify(snapshot.state)}`);
    }
    await page.waitForTimeout(100);
  } while (Date.now() < deadline);
  assert.fail(`${description}: ${JSON.stringify(snapshot?.state || null)}`);
}

async function openPluginSettings(page) {
  await page.click('#settingsTopRailTab');
  await page.click('.settings-nav [data-settings-section="plugins"]');
  await page.waitForSelector('#pluginsSettingsGroup', { timeout: 15_000 });
}

async function waitForOperation(page, operationId, description) {
  assert.match(String(operationId || ''), /^[a-z0-9][a-z0-9_-]{0,63}$/);
  const deadline = Date.now() + 30_000;
  let status;
  do {
    status = await page.evaluate((operation_id) => (
      window.jennyShell.plugins.getOperation({ operation_id })
    ), operationId);
    if (status?.classification === 'terminal') return status;
    await page.waitForTimeout(100);
  } while (Date.now() < deadline);
  assert.fail(`${description}: ${JSON.stringify(status || null)}`);
}

async function approveConsentWindow(consent) {
  await consent.waitForSelector('#acknowledge', { timeout: 10_000 });
  await consent.waitForFunction(() => document.getElementById('contribution')?.textContent);
  const model = await consent.evaluate(() => ({
    title: document.getElementById('consentTitle')?.textContent || '',
    publisher: document.getElementById('publisher')?.textContent || '',
    contribution: document.getElementById('contribution')?.textContent || '',
    body: document.body.innerText,
  }));
  if (model.title !== 'Share a secret value?') {
    assert.match(model.title, new RegExp(`^Allow ${model.contribution} to run with your account permissions\\?`));
  }
  assert.equal(model.publisher, PUBLISHER_ID);
  assert.ok(CONTRIBUTION_KINDS.includes(model.contribution.replace(/^conformance_/, '')),
    `unexpected Stage 8 consent contribution: ${model.contribution}`);
  assert.match(model.body, /Plugin content cannot appear here/);
  assert.match(model.body, /Same-user access: files and network available to your Windows account/i);
  assert.match(model.body, /Containment: Windows job: kill-on-close; account\/network permissions remain/i);
  assert.match(model.body, /cannot revoke bytes already observed/i);
  assert.equal(await consent.locator('#approve').isDisabled(), true);
  await consent.locator('#acknowledge').check();
  const closed = consent.waitForEvent('close', { timeout: 10_000 });
  await consent.locator('#approve').click();
  await closed;
  return model.contribution;
}

async function approveRequiredLaunches(app, page, profile, { since = 0, hookCount = REQUIRED_CONFORMANCE_HOOK_LAUNCHES } = {}) {
  const clicked = [];
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const evidence = readConsentApprovals(profile).slice(since);
    if (consentEvidenceComplete(evidence, hookCount)) return { evidence, clicked };
    const consent = app.windows().find((candidate) => (
      candidate.url().includes('plugin-consent.html')
    ));
    if (consent) {
      clicked.push(await approveConsentWindow(consent));
      continue;
    }
    const rendererError = await page.evaluate(() => (
      document.querySelector('[data-plugins-last-error]')?.textContent || ''
    ));
    if (rendererError) {
      assert.fail(`signed V6 activation failed before consent: ${rendererError}; ${JSON.stringify(await pluginState(page))}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail(`signed V6 activation consent sequence did not settle: ${JSON.stringify(clicked)}`);
}

async function approveContributionLaunch(app, page, profile, contributionId, since) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const evidence = readConsentApprovals(profile).slice(since);
    if (evidence.includes(contributionId)) return evidence;
    const consent = app.windows().find((candidate) => candidate.url().includes('plugin-consent.html'));
    if (consent) {
      await approveConsentWindow(consent);
      continue;
    }
    const rendererError = await page.evaluate(() => (
      document.querySelector('[data-plugins-last-error]')?.textContent || ''
    ));
    if (rendererError) assert.fail(`signed V6 contribution launch failed: ${rendererError}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail(`signed V6 contribution consent missing: ${contributionId}`);
}

async function sendPromptAndSettle(page, prompt) {
  const sent = await page.evaluate((text) => window.__jennyAgent.sendPrompt(text), prompt);
  assert.equal(sent, true, 'signed V6 composer accepted the prompt');
  await page.waitForFunction(
    () => window.__jennyAgent.getStateSnapshot().pendingStreamIds.length > 0,
    null,
    { timeout: 10_000 }
  );
  const settled = await page.evaluate(() => window.__jennyAgent.waitForIdle({ timeoutMs: 60_000 }));
  assert.equal(settled, true, 'signed V6 turn settled');
}

async function loadModelWhenIdle(page, model) {
  const deadline = Date.now() + 15_000;
  let lastError;
  do {
    try {
      return await page.evaluate((modelId) => window.jennyShell.models.load(modelId), model);
    } catch (error) {
      lastError = error;
      if (!String(error?.message || error).includes('initialization is already in progress')) throw error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  } while (Date.now() < deadline);
  throw lastError || new Error(`model load did not become idle: ${model}`);
}

async function runSignedStage8PackageFlow(t, {
  signedPackage,
  profile,
  activate = true,
  exerciseContributions = false,
  launch,
  registerAuth,
} = {}) {
  assertSignedPackage(signedPackage);
  t.diagnostic('stage8 signed package smoke: launching Jenny');
  let launched = await launch();
  t.diagnostic('stage8 signed package smoke: Jenny ready; registering isolated auth');
  await registerAuth(launched.page);
  await launched.app.evaluate(({ dialog }, selectedPath) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selectedPath] });
  }, signedPackage);

  await openPluginSettings(launched.page);
  t.diagnostic('stage8 signed package smoke: installing signed V6 package');
  const installed = await launched.page.evaluate(() => (
    window.jennyShell.plugins.installLocalPackage({})
  ));
  assert.equal(installed?.ok, true, `signed V6 intake failed: ${JSON.stringify(installed)}`);
  assert.notEqual(installed?.canceled, true, `signed V6 picker was canceled: ${JSON.stringify(installed)}`);
  const installation = await waitForOperation(
    launched.page,
    installed.operation_id,
    'signed V6 distribution operation settles'
  );
  let operationRecord = null;
  let storeEvidence = null;
  if (installation.receipt?.status !== 'committed') {
    try {
      operationRecord = JSON.parse(fs.readFileSync(path.join(
        profile,
        'plugins',
        'distribution',
        'operations',
        `${installed.operation_id}.json`
      ), 'utf8'));
    } catch (_error) {
      operationRecord = { terminal_reason: 'operation_record_unavailable' };
    }
    storeEvidence = readStoreEvidence(profile);
  }
  assert.equal(
    installation.receipt?.status,
    'committed',
    `signed V6 distribution failed: ${JSON.stringify({ installation, operationRecord, storeEvidence })}`
  );
  let snapshot = await waitForPlugin(
    launched.page,
    (plugin) => plugin.effective_state === 'installed_disabled',
    'signed V6 installation settles'
  );
  assert.equal(snapshot.state.ok, true);
  assert.equal(snapshot.state.stage8_enabled, true);
  assert.equal(snapshot.plugin.resolved_version, '1.0.0');
  assert.deepEqual(
    snapshot.plugin.contributions.map((item) => item.kind).sort(),
    CONTRIBUTION_KINDS
  );
  assert.ok(snapshot.plugin.contributions.every((item) => item.effective_enabled === false));

  if (!activate) {
    t.diagnostic('stage8 signed package smoke: inactive install committed; relaunching');
    await launched.app.close();
    launched = await launch();
    await openPluginSettings(launched.page);
    snapshot = await waitForPlugin(
      launched.page,
      (plugin, state) => plugin.effective_state === 'installed_disabled'
        && plugin.contributions.every((item) => item.effective_enabled === false)
        && Number(state.host_sessions?.active) === 0
        && Number(state.host_sessions?.pending) === 0,
      'signed V6 inactive restart rehydration settles'
    );
    assert.equal(snapshot.state.stage8_enabled, true);
    t.diagnostic('stage8 signed package smoke: inactive rehydration passed');
    return;
  }

  const rowSelector = `[data-plugin-row="${PUBLISHER_ID}/${PLUGIN_ID}"]`;
  await launched.page.click(`${rowSelector} [data-plugins-settings-action="enable"]`);
  await approveRequiredLaunches(launched.app, launched.page, profile);
  snapshot = await waitForPlugin(
    launched.page,
    (plugin, state) => plugin.effective_state === 'active'
      && plugin.contributions.every((item) => item.effective_enabled === true)
      && Number(state.host_sessions?.active) >= 1,
    'signed V6 activation settles'
  );
  const consentApprovals = await waitForConsentApprovals(profile);
  const approvalKinds = new Set(consentApprovals.map((item) => item.replace(/^conformance_/, '')));
  assert.deepEqual([...approvalKinds].sort(), [...CONTRIBUTION_KINDS].sort());
  assert.ok(
    consentApprovals.filter((item) => item === 'conformance_hook').length
      >= REQUIRED_CONFORMANCE_HOOK_LAUNCHES,
    `descriptor probe and post-commit hook launch both require consent: ${consentApprovals.join(', ')}`);
  assert.match(snapshot.plugin.generation_id, /^gen-/);
  assert.equal(snapshot.state.privileged_runtime_status, 'ready');

  const restartConsentOffset = readConsentApprovals(profile).length;
  await launched.app.close();
  launched = await launch();
  await approveRequiredLaunches(launched.app, launched.page, profile, {
    since: restartConsentOffset,
    hookCount: 1,
  });
  await openPluginSettings(launched.page);
  snapshot = await waitForPlugin(
    launched.page,
    (plugin) => plugin.effective_state === 'active'
      && plugin.contributions.every((item) => item.effective_enabled === true),
    'signed V6 restart rehydration settles'
  );
  assert.equal(snapshot.state.stage8_enabled, true);

  if (exerciseContributions) {
    const replaySettings = await launched.page.evaluate(() => window.jennyShell.engines.updateSettings({
      preferredEngineType: 'replay',
    }));
    assert.equal(replaySettings?.preferredEngineType, 'replay');
    const replayLoaded = await loadModelWhenIdle(launched.page, 'replay-stage8');
    assert.equal(replayLoaded?.status, 'ok', `replay model load failed: ${JSON.stringify(replayLoaded)}`);
    await launched.page.click('#chatTopRailTab');
    let consentOffset = readConsentApprovals(profile).length;
    const nativeTurn = sendPromptAndSettle(launched.page, 'Exercise the signed Stage 8 native tool.');
    await approveContributionLaunch(
      launched.app, launched.page, profile, 'conformance_native_mcp', consentOffset
    );
    await nativeTurn;
    const nativeText = await launched.page.locator('body').innerText();
    assert.match(nativeText, /synthetic conformance result/i);

    consentOffset = readConsentApprovals(profile).length;
    await launched.app.close();
    launched = await launch();
    await approveRequiredLaunches(launched.app, launched.page, profile, {
      since: consentOffset,
      hookCount: 1,
    });
    const settings = await launched.page.evaluate(() => window.jennyShell.engines.updateSettings({
      preferredEngineType: 'plugin_host',
    }));
    assert.equal(settings?.preferredEngineType, 'plugin_host');
    const loaded = await loadModelWhenIdle(launched.page, 'stage8_conformance');
    assert.equal(loaded?.status, 'ok', `plugin-host model load failed: ${JSON.stringify(loaded)}`);
    await launched.page.click('#chatTopRailTab');
    consentOffset = readConsentApprovals(profile).length;
    const engineTurn = sendPromptAndSettle(launched.page, 'Exercise the signed Stage 8 engine.');
    await approveContributionLaunch(
      launched.app, launched.page, profile, 'conformance_engine_adapter', consentOffset
    );
    await engineTurn;
    const engineText = await launched.page.locator('body').innerText();
    assert.match(engineText, /synthetic conformance response/i);

    consentOffset = readConsentApprovals(profile).length;
    const secretDrill = launched.app.evaluate(() => (
      globalThis.__jennyStage8OwnerDrill.runSyntheticSecretDelivery()
    ));
    await approveContributionLaunch(
      launched.app, launched.page, profile, 'conformance_engine_adapter', consentOffset
    );
    const secretResult = await secretDrill;
    assert.equal(secretResult?.ok, true, `synthetic secret delivery failed: ${JSON.stringify(secretResult)}`);
    assert.equal(secretResult?.replay_reason, 'secret_grant_spent_or_missing');
    assert.match(secretResult?.delivery_receipt_id || '', /^[a-z0-9][a-z0-9_-]{0,63}$/);
    assert.match(secretResult?.source_id_digest || '', /^[0-9a-f]{64}$/);
    await openPluginSettings(launched.page);
  }

  await launched.page.click(`${rowSelector} [data-plugins-settings-action="disable"]`);
  snapshot = await waitForPlugin(
    launched.page,
    (plugin, state) => plugin.effective_state === 'installed_disabled'
      && plugin.contributions.every((item) => item.effective_enabled === false)
      && Number(state.host_sessions?.active) === 0
      && Number(state.host_sessions?.pending) === 0,
    'signed V6 disable terminates privileged sessions'
  );
  assert.notEqual(snapshot.state.privileged_cleanup_status, 'termination_failed');
}

module.exports = { runSignedStage8PackageFlow };
