'use strict';

// Fault injection for the shell config store (matrix rows C1-C10, C12, C13 in
// docs/plans/PERSISTENCE_FAULTS_2026-10-26.md). Crash rows run a child that
// SIGKILLs itself around a real rename; IO-fault rows monkeypatch
// fs.renameSync for one call. Fixtures at the current schema are written by the
// real service; only the damage or the re-stamp is applied by hand. No sleeps.

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { ShellConfigService } = require('../services/shell-config-service');
const { CONFIG_VERSION } = require('../services/shell-config-state');
const { workspaceRootId } = require('../services/workspace-root-identity');
const { buildCleanupTargets } = require('../services/data-lifecycle/cleanup-service');
const { PortablePreferencesStore } = require('../services/data-lifecycle/portable-preferences-store');
const { FIXED_NOW, agentNameFor, createService, saveStep } = require('./helpers/shell-config-fault-child');
const {
  cleanupTrackedResources,
  createTrackedTempDir,
  trackProcess,
} = require('./helpers/resource-cleanup');

const CHILD = path.join(__dirname, 'helpers', 'shell-config-fault-child.js');
const CONFIG_NAME = 'shell-config.json';
const TMP_ORPHAN = /^shell-config\.json\.\d{10,16}\.[0-9a-f]{12}\.tmp$/;

test.afterEach(async () => {
  await cleanupTrackedResources();
});

function newProfile() {
  return createTrackedTempDir('jenny-shell-config-faults-');
}

function configPathOf(dir) {
  return path.join(dir, CONFIG_NAME);
}

function openService(dir, extra = {}) {
  const events = [];
  const service = new ShellConfigService({
    userDataPath: dir,
    env: {},
    nowProvider: () => FIXED_NOW,
    logger: (level, event, data) => events.push({ level, event, data }),
    ...extra,
  });
  return { service, events };
}

function named(events, event) {
  return events.filter((entry) => entry.event === event);
}

function listDir(dir) {
  return fs.readdirSync(dir).sort();
}

function preservedCopies(dir) {
  return listDir(dir).filter((name) => name.startsWith(`${CONFIG_NAME}.corrupt-`));
}

// Saves a spread of user-set preferences through the real service and returns
// the exact bytes and state it produced. `appZoom` stays off 100 by default so
// the v57 retirement of a stored 100 does not apply.
function writeSeededProfile(dir, { appZoom = 125, tokenBudgetOverride = false } = {}) {
  const workspaceRoot = path.join(dir, 'workspace-root');
  fs.mkdirSync(workspaceRoot, { recursive: true });
  const { service } = openService(dir);
  service.updateChatUiSettings({
    uiLanguage: 'es',
    safetyMode: 'strict',
    zoomPercent: 120,
    use24HourTime: true,
    autoApproveStreakCap: 20,
    unattendedGuardMinutes: 15,
  });
  service.updateWindowUiSettings({ appZoomPercent: appZoom });
  service.updateFeatureSettings({
    featureOverrides: {
      context_compaction: false,
      git_tracking: false,
      ...(tokenBudgetOverride ? { token_budget: true } : {}),
    },
  });
  service.updateAssistantIdentity({ agentName: 'Ada' });
  service.setToolsWorkspaceRoot(workspaceRoot);
  service.updateWorkspaceIdePreferences({ fontSize: 15, wordWrap: 'on' });
  service.updateWorkspaceIdeState(workspaceRootId(workspaceRoot), {
    openTabs: [{ path: 'src/a.js' }],
    activeTabPath: 'src/a.js',
    expandedDirs: ['src'],
  });
  // Per-root IDE state is debounced; flush it now instead of waiting on the timer.
  service.flushPendingWorkspaceWrite();
  const state = service.getState();
  const bytes = fs.readFileSync(configPathOf(dir));
  return { state, bytes, workspaceRoot };
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeJson(file, value) {
  fs.writeFileSync(file, JSON.stringify(value, null, 2), 'utf8');
}

function replaceOnce(text, from, to) {
  const index = text.indexOf(from);
  assert.notEqual(index, -1, `fixture text not found: ${from}`);
  assert.equal(text.indexOf(from, index + 1), -1, `fixture text not unique: ${from}`);
  return text.slice(0, index) + to + text.slice(index + from.length);
}

function defaultState() {
  return openService(newProfile()).service.getState();
}

// Dotted paths at which two JSON-like values differ; empty when equal.
function diffPaths(left, right, prefix = '') {
  if (JSON.stringify(left) === JSON.stringify(right)) return [];
  const isObj = (value) => value && typeof value === 'object';
  if (!isObj(left) || !isObj(right) || Array.isArray(left) !== Array.isArray(right)) return [prefix || '(root)'];
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  return [...keys].flatMap((key) => diffPaths(left[key], right[key], prefix ? `${prefix}.${key}` : key));
}

function spyShellConfigRenames(t, onRename = null) {
  const realRename = fs.renameSync;
  const seen = [];
  fs.renameSync = function spiedRename(from, to, ...rest) {
    if (path.basename(String(to)) === CONFIG_NAME) {
      seen.push(String(to));
      if (onRename) onRename(seen.length);
    }
    return realRename.call(this, from, to, ...rest);
  };
  t.after(() => { fs.renameSync = realRename; });
  return seen;
}

// ---------------------------------------------------------------- C1 / C2

function runCrashChild(dir, mode, killAt) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CHILD, dir, mode, String(killAt)], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    trackProcess(child);
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code, signal) => {
      resolve({
        code,
        signal,
        stderr,
        acks: stdout.split('\n').filter(Boolean).map(Number),
      });
    });
  });
}

function replayState(lastSeq) {
  const dir = newProfile();
  const { service } = openService(dir);
  for (let seq = 1; seq <= lastSeq; seq += 1) saveStep(service, seq);
  return service.getState();
}

for (const [row, mode] of [['C1', 'kill-before'], ['C2', 'kill-after']]) {
  for (const killAt of [1, 3]) {
    test(`${row} ${mode} at save ${killAt}: reopening loads a whole acknowledged-or-in-flight state`, { timeout: 60000 }, async () => {
      const dir = newProfile();
      const run = await runCrashChild(dir, mode, killAt);
      assert.notEqual(run.code, 0, `child must not exit cleanly (signal=${run.signal}, stderr=${run.stderr})`);
      assert.deepEqual(run.acks, Array.from({ length: killAt - 1 }, (_, index) => index + 1));

      const lastAcked = killAt - 1;
      const survivingSeq = mode === 'kill-before' ? lastAcked : killAt;

      // The file on disk is parseable (never torn) before any service touches it.
      if (survivingSeq > 0) {
        const parsed = readJson(configPathOf(dir));
        assert.equal(parsed.version, CONFIG_VERSION);
        assert.equal(parsed.assistantIdentity.agentName, agentNameFor(survivingSeq));
      } else {
        assert.equal(fs.existsSync(configPathOf(dir)), false, 'no save completed, so no config file');
      }

      const orphans = listDir(dir).filter((name) => name.endsWith('.tmp'));
      if (mode === 'kill-before') {
        assert.equal(orphans.length, 1, `exactly the in-flight temp file is left: ${orphans}`);
        assert.match(orphans[0], TMP_ORPHAN);
        // The temp file was fully written and synced before the kill: it is the in-flight value, whole.
        const orphan = readJson(path.join(dir, orphans[0]));
        assert.equal(orphan.assistantIdentity.agentName, agentNameFor(killAt));
        // Only an explicit data removal owns it; nothing reaps it at startup.
        const owned = buildCleanupTargets({ userDataPath: dir })
          .filter((target) => target.kind === 'user_data_derived_child')
          .map((target) => target.name);
        assert.ok(owned.includes(orphans[0]), 'data removal recognises the orphan as Jenny-owned');
      } else {
        assert.deepEqual(orphans, [], 'the rename consumed the temp file');
      }

      const { service, events } = openService(dir);
      assert.equal(named(events, 'shell_config.corrupt_state_detected').length, 0);
      assert.deepEqual(service.getState(), replayState(survivingSeq));
      assert.equal(service.getState().assistantIdentity.agentName, survivingSeq ? agentNameFor(survivingSeq) : 'Jenny');

      // The store is writable after the crash.
      service.updateAssistantIdentity({ agentName: 'after-crash' });
      assert.equal(openService(dir).service.getState().assistantIdentity.agentName, 'after-crash');
    });
  }
}

// ------------------------------------------------------- C3 / C4 / C5 corrupt

function assertCorruptHandled(damagedBytes, expectedErrorCode) {
  const dir = newProfile();
  fs.writeFileSync(configPathOf(dir), damagedBytes);
  const before = listDir(dir);

  const { service, events } = openService(dir);

  const copies = preservedCopies(dir);
  assert.equal(copies.length, 1, `one preserved copy: ${listDir(dir)}`);
  assert.match(copies[0], /^shell-config\.json\.corrupt-\d{10,16}$/);
  assert.ok(Buffer.from(damagedBytes).equals(fs.readFileSync(path.join(dir, copies[0]))), 'preserved bytes intact');
  assert.equal(fs.existsSync(configPathOf(dir)), false, 'the damaged file was moved, not rewritten at load');
  assert.deepEqual(service.getState(), defaultState());
  assert.equal(service.isFreshInstall(), false);

  const detected = named(events, 'shell_config.corrupt_state_detected');
  assert.equal(detected.length, 1);
  assert.equal(detected[0].level, 'ERROR');
  assert.equal(detected[0].data.fileName, CONFIG_NAME);
  assert.equal(detected[0].data.preserved, true);
  assert.equal(detected[0].data.preservedName, copies[0]);
  assert.equal(detected[0].data.errorCode, expectedErrorCode);

  service.updateAssistantIdentity({ agentName: 'Fresh' });
  assert.equal(readJson(configPathOf(dir)).assistantIdentity.agentName, 'Fresh');
  assert.equal(readJson(configPathOf(dir)).version, CONFIG_VERSION);
  assert.ok(Buffer.from(damagedBytes).equals(fs.readFileSync(path.join(dir, copies[0]))), 'preserved copy untouched by the next save');
  const after = listDir(dir);
  for (const name of before) assert.ok(after.includes(name) || name === CONFIG_NAME, `${name} deleted`);
  assert.equal(named(events, 'shell_config.corrupt_state_detected').length, 1, 'still one detection event');
}

test('C3 truncated JSON is preserved, defaults are served, the next save starts a fresh file', () => {
  const { bytes } = writeSeededProfile(newProfile());
  assertCorruptHandled(bytes.subarray(0, Math.floor(bytes.length / 2)), 'invalid_json');
});

test('C4 a flipped byte inside a string value still parses and loads as is', () => {
  const dir = newProfile();
  const { state, bytes } = writeSeededProfile(dir);
  const flipped = replaceOnce(bytes.toString('utf8'), '"agentName": "Ada"', '"agentName": "Adb"');
  fs.writeFileSync(configPathOf(dir), flipped);

  const { service, events } = openService(dir);
  assert.equal(service.getState().assistantIdentity.agentName, 'Adb');
  assert.deepEqual(
    diffPaths(state, service.getState()),
    ['assistantIdentity.agentName'],
    'only the flipped string differs'
  );
  assert.equal(named(events, 'shell_config.corrupt_state_detected').length, 0);
  assert.deepEqual(preservedCopies(dir), []);
  assert.equal(fs.readFileSync(configPathOf(dir), 'utf8'), flipped, 'loading does not rewrite the file');
});

for (const [label, damage] of [
  ['a colon turned into a semicolon', (text) => replaceOnce(text, '"uiLanguage": "es"', '"uiLanguage"; "es"')],
  ['the closing brace turned into a bracket', (text) => `${text.trimEnd().slice(0, -1)}]`],
]) {
  test(`C4 a flipped structural byte (${label}) is handled like truncation`, () => {
    const { bytes } = writeSeededProfile(newProfile());
    assertCorruptHandled(Buffer.from(damage(bytes.toString('utf8')), 'utf8'), 'invalid_json');
  });
}

for (const [label, text] of [['a top-level array', '[{"version": 59}]'], ['a top-level null', 'null']]) {
  test(`C5 valid JSON of the wrong shape (${label}) is handled like truncation`, () => {
    assertCorruptHandled(Buffer.from(text, 'utf8'), 'not_an_object');
  });
}

// ------------------------------------------------------------ C6 / C10 migrate

function userPrefsOf(state) {
  return {
    uiLanguage: state.uiLanguage,
    safetyMode: state.safetyMode,
    chatZoom: state.chatUi.zoomPercent,
    appZoom: state.windowUi.appZoomPercent,
    contextCompaction: state.featureOverrides.context_compaction,
    gitTracking: state.featureOverrides.git_tracking,
    agentName: state.assistantIdentity.agentName,
    toolsWorkspaceRoot: state.toolsWorkspaceRoot,
    use24HourTime: state.use24HourTime,
    autoApproveStreakCap: state.autoApproveStreakCap,
    unattendedGuardMinutes: state.unattendedGuardMinutes,
  };
}

test('C6 a config with no version key migrates and keeps every listed user preference', () => {
  const dir = newProfile();
  const { state, workspaceRoot } = writeSeededProfile(dir);
  const stamped = readJson(configPathOf(dir));
  delete stamped.version;
  writeJson(configPathOf(dir), stamped);

  const { service, events } = openService(dir);
  const loaded = service.getState();
  assert.equal(loaded.version, CONFIG_VERSION);
  assert.deepEqual(userPrefsOf(loaded), userPrefsOf(state));
  assert.deepEqual(userPrefsOf(loaded), {
    uiLanguage: 'es',
    safetyMode: 'strict',
    chatZoom: 120,
    appZoom: 125,
    contextCompaction: false,
    gitTracking: false,
    agentName: 'Ada',
    toolsWorkspaceRoot: workspaceRoot,
    use24HourTime: true,
    autoApproveStreakCap: 20,
    unattendedGuardMinutes: 15,
  });
  assert.equal(named(events, 'shell_config.corrupt_state_detected').length, 0);
  assert.deepEqual(preservedCopies(dir), []);
});

// The one-way retirements a version-1 re-run applies to current data: the
// token_budget override (v58) and a stored app zoom of 100 (v57, becomes the
// new default). Everything else must come back unchanged.
function expectedAfterRetirements(state, { appZoomWas100 }) {
  const expected = JSON.parse(JSON.stringify(state));
  delete expected.featureOverrides.token_budget;
  if (appZoomWas100) expected.windowUi.appZoomPercent = 110;
  return expected;
}

test('C10 a current config re-stamped version 1 loads equal to itself except the documented retirements', () => {
  const dir = newProfile();
  const { state } = writeSeededProfile(dir, { tokenBudgetOverride: true });
  assert.equal(state.featureOverrides.token_budget, true, 'fixture exercises the v58 retirement');
  assert.equal(state.windowUi.appZoomPercent, 125, 'fixture keeps app zoom off 100');
  const stamped = readJson(configPathOf(dir));
  stamped.version = 1;
  writeJson(configPathOf(dir), stamped);

  const loaded = openService(dir).service.getState();
  const expected = expectedAfterRetirements(state, { appZoomWas100: false });
  assert.deepEqual(diffPaths(expected, loaded), [], 'fields changed by re-running every migration');
  // Compared as serialized: the store normalizer builds null-prototype maps.
  assert.deepEqual(JSON.parse(JSON.stringify(loaded)), expected);
});

test('C10 a stored app zoom of 100 is the one value the v57 step flips', () => {
  const dir = newProfile();
  const { state } = writeSeededProfile(dir, { appZoom: 100 });
  assert.equal(state.windowUi.appZoomPercent, 100);
  const stamped = readJson(configPathOf(dir));
  stamped.version = 1;
  writeJson(configPathOf(dir), stamped);

  const loaded = openService(dir).service.getState();
  const expected = expectedAfterRetirements(state, { appZoomWas100: true });
  assert.deepEqual(
    diffPaths(expected, loaded).filter((dotted) => !dotted.startsWith('workspaceIde')),
    [],
    'fields changed by re-running every migration (workspaceIde is pinned by the test above)'
  );
  assert.equal(loaded.windowUi.appZoomPercent, 110);
});

// ------------------------------------------------------------------------ C7

test('C7 a config from the future is served, every setter is refused, the file is untouched', () => {
  const dir = newProfile();
  const { state, workspaceRoot } = writeSeededProfile(dir);
  const future = readJson(configPathOf(dir));
  future.version = CONFIG_VERSION + 1;
  writeJson(configPathOf(dir), future);
  const bytesBefore = fs.readFileSync(configPathOf(dir));
  const listingBefore = listDir(dir);

  const { service, events } = openService(dir);
  assert.equal(service.getState().assistantIdentity.agentName, 'Ada');
  assert.equal(service.getState().uiLanguage, 'es');
  const served = service.getState();
  const changed = [];
  service.on('changed', (_snapshot, details) => changed.push(details.reason));

  const setters = {
    updateChatUiSettings: () => service.updateChatUiSettings({ uiLanguage: 'fr', zoomPercent: 90 }),
    updateUiLanguage: () => service.updateUiLanguage('de'),
    updateWindowUiSettings: () => service.updateWindowUiSettings({ appZoomPercent: 130 }),
    updateFeatureSettings: () => service.updateFeatureSettings({ featureOverrides: { git_tracking: true } }),
    updateAssistantIdentity: () => service.updateAssistantIdentity({ agentName: 'Nope' }),
    setToolsWorkspaceRoot: () => service.setToolsWorkspaceRoot(path.join(workspaceRoot, 'other')),
    markSetupComplete: () => service.markSetupComplete(),
    resetOnboarding: () => service.resetOnboarding(),
    updateEngineTuning: () => service.updateEngineTuning({ maxBudgetUsd: 5 }),
    updateWorkspaceState: () => service.updateWorkspaceState({ activeSessionId: 'chat-1', openSessionIds: ['chat-1'] }),
    flushPendingWorkspaceWrite: () => service.flushPendingWorkspaceWrite(),
  };
  for (const [name, call] of Object.entries(setters)) {
    try {
      call();
    } catch (_error) {
      // A refused write may throw or report not persisted; either is a refusal.
    }
    assert.deepEqual(service.getState(), served, `${name} moved in-memory state ahead of the refused write`);
  }

  assert.deepEqual(changed, [], 'no change event for a refused write');
  assert.ok(fs.readFileSync(configPathOf(dir)).equals(bytesBefore), 'file byte-identical');
  assert.deepEqual(listDir(dir), listingBefore, 'no temp or preserved file appeared');
  assert.equal(named(events, 'shell_config.newer_schema_write_blocked').length, 1);
  assert.equal(named(events, 'shell_config.newer_schema_detected').length, 1);
  assert.equal(served.assistantIdentity.agentName, state.assistantIdentity.agentName);
});

// ------------------------------------------------------------------------ C8

test('C8 out-of-range and wrong-typed numbers are clamped or defaulted on read', () => {
  const dir = newProfile();
  writeSeededProfile(dir);
  const damaged = readJson(configPathOf(dir));
  damaged.chatUi.zoomPercent = -50;
  damaged.windowUi.appZoomPercent = 'not a number';
  damaged.autoApproveStreakCap = -7;
  damaged.unattendedGuardMinutes = -3;
  writeJson(configPathOf(dir), damaged);

  const { service, events } = openService(dir);
  const state = service.getState();
  assert.equal(state.chatUi.zoomPercent, 85, 'negative chat zoom clamps to the minimum');
  assert.equal(state.windowUi.appZoomPercent, 110, 'non-numeric app zoom takes the default');
  assert.equal(state.autoApproveStreakCap, 0, 'negative streak cap clamps to zero');
  assert.equal(state.unattendedGuardMinutes, 0, 'negative guard minutes take the default');
  assert.equal(named(events, 'shell_config.corrupt_state_detected').length, 0);

  const huge = readJson(configPathOf(dir));
  huge.chatUi.zoomPercent = '9999';
  huge.autoApproveStreakCap = 1e9;
  huge.unattendedGuardMinutes = 1e9;
  writeJson(configPathOf(dir), huge);
  const second = openService(dir).service.getState();
  assert.equal(second.chatUi.zoomPercent, 135, 'a numeric string is coerced then clamped to the maximum');
  assert.equal(second.autoApproveStreakCap, 500);
  assert.equal(second.unattendedGuardMinutes, 120);

  service.updateAssistantIdentity({ agentName: 'Sane' });
  const written = readJson(configPathOf(dir));
  assert.equal(written.chatUi.zoomPercent, 85, 'the next save writes the clamped value');
  assert.equal(written.autoApproveStreakCap, 0);
});

// ------------------------------------------------------------------------ C9

test('C9 rebuilding the service over a current file writes nothing and keeps state', (t) => {
  const dir = newProfile();
  const { state, bytes } = writeSeededProfile(dir, { tokenBudgetOverride: true });
  const listing = listDir(dir);
  const renames = spyShellConfigRenames(t);

  const { service, events } = openService(dir);
  assert.deepEqual(renames, [], 'the constructor did not rename onto shell-config.json');
  assert.ok(fs.readFileSync(configPathOf(dir)).equals(bytes), 'file byte-identical after load');
  assert.deepEqual(listDir(dir), listing);
  assert.deepEqual(service.getState(), state);
  assert.equal(service.isFreshInstall(), false);
  assert.deepEqual(events.filter((entry) => entry.level === 'ERROR' || entry.level === 'WARN'), []);
});

test('C9 an agent-quiet launch seeds the profile once, a rebuild with the same env writes nothing', (t) => {
  const dir = newProfile();
  const env = { JENNY_AGENT_DEV: '1' };
  openService(dir, { env });
  const seeded = fs.readFileSync(configPathOf(dir));
  const renames = spyShellConfigRenames(t);

  const { service } = openService(dir, { env });
  assert.deepEqual(renames, [], 'the second construction found nothing left to seed');
  assert.ok(fs.readFileSync(configPathOf(dir)).equals(seeded));
  assert.equal(service.getState().setup.firstRunCompleted, true);
});

// ----------------------------------------------------------------------- C12

test('C12 EPERM from the rename fails the save, leaves the file and state alone, and the next save works', (t) => {
  const dir = newProfile();
  const { state, bytes } = writeSeededProfile(dir);
  const { service, events } = openService(dir);
  const changed = [];
  service.on('changed', (_snapshot, details) => changed.push(details.reason));
  const listing = listDir(dir);

  const realRename = fs.renameSync;
  let injected = 0;
  fs.renameSync = function failingRename(from, to, ...rest) {
    if (injected === 0 && path.basename(String(to)) === CONFIG_NAME) {
      injected += 1;
      throw Object.assign(new Error('EPERM: operation not permitted, rename'), { code: 'EPERM' });
    }
    return realRename.call(this, from, to, ...rest);
  };
  t.after(() => { fs.renameSync = realRename; });

  assert.throws(
    () => service.updateAssistantIdentity({ agentName: 'Blocked' }),
    (error) => error && error.code === 'EPERM'
  );
  assert.equal(injected, 1);
  const failures = named(events, 'shell_config.write_failed');
  assert.equal(failures.length, 1);
  assert.equal(failures[0].level, 'WARN');
  assert.equal(failures[0].data.errorCode, 'EPERM');
  assert.equal(path.basename(failures[0].data.filePath), CONFIG_NAME);
  assert.ok(fs.readFileSync(configPathOf(dir)).equals(bytes), 'file byte-identical after the failed save');
  assert.deepEqual(service.getState(), state, 'in-memory state is not ahead of disk');
  assert.deepEqual(changed, [], 'no change event for the failed save');
  assert.deepEqual(listDir(dir), listing, 'the temp file of the failed write was removed');

  service.updateAssistantIdentity({ agentName: 'Recovered' });
  assert.equal(service.getState().assistantIdentity.agentName, 'Recovered');
  assert.equal(readJson(configPathOf(dir)).assistantIdentity.agentName, 'Recovered');
  assert.equal(openService(dir).service.getState().assistantIdentity.agentName, 'Recovered');
  assert.equal(named(events, 'shell_config.write_failed').length, 1, 'only the injected failure was logged');
});

// ----------------------------------------------------------------------- C13
//
// Classification (from source): portable-preferences.json is NOT a projection of
// shell-config. It mirrors renderer state: `appearance` is read from renderer
// localStorage and `preferredModel` from the composer select
// (renderer-data-lifecycle.js syncPortablePreferences), neither of which lives in
// shell-config.json. The renderer re-sends appearance on every launch, so the
// file is mostly regenerable, but the mirror can be the only copy, so sync()
// moves a damaged file aside before regenerating it (fault F4). The tests pin:
// read() tolerates it, sync() regenerates a valid file, the damaged bytes are kept.

function seedPortablePreferences(dir) {
  const store = new PortablePreferencesStore(dir);
  store.sync({ appearance: { paletteId: 'ember', fontScaleId: 'large' }, preferredModel: 'qwen3:8b' });
  return store;
}

test('C13 a corrupt portable preferences file reads as absent and is left untouched by read()', () => {
  const dir = newProfile();
  const store = seedPortablePreferences(dir);
  const damaged = Buffer.from('{"schema_version": 1, "appearance": {"paletteId": "emb', 'utf8');
  fs.writeFileSync(store.filePath, damaged);

  assert.equal(store.read(), null);
  assert.ok(fs.readFileSync(store.filePath).equals(damaged));
  assert.deepEqual(listDir(path.dirname(store.filePath)), ['portable-preferences.json']);
});

test('C13 sync() over a corrupt file regenerates a valid file from the renderer patch', () => {
  const dir = newProfile();
  const store = seedPortablePreferences(dir);
  fs.writeFileSync(store.filePath, '{"schema_version": 1, "appearance": {"paletteId": "emb', 'utf8');

  const next = store.sync({ appearance: { paletteId: 'ember', fontScaleId: 'large' } });
  assert.equal(next.appearance.paletteId, 'ember');
  assert.deepEqual(new PortablePreferencesStore(dir).read().appearance, { paletteId: 'ember', fontScaleId: 'large' });
});

test('C13 sync() keeps the damaged bytes beside the regenerated file', () => {
  const dir = newProfile();
  const store = seedPortablePreferences(dir);
  const damaged = Buffer.from('{"schema_version": 1, "appearance": {"paletteId": "emb', 'utf8');
  fs.writeFileSync(store.filePath, damaged);

  store.sync({ appearance: { paletteId: 'ember' } });
  const folder = path.dirname(store.filePath);
  const copies = listDir(folder).filter((name) => name.startsWith('portable-preferences.json.corrupt-'));
  assert.equal(copies.length, 1, `damaged portable preferences must be preserved before regeneration: ${listDir(folder)}`);
  assert.ok(damaged.equals(fs.readFileSync(path.join(folder, copies[0]))));
});
