'use strict';

// Throwaway profile + sample workspace for one demo clip recording.
//
// Builds on capture-ui.js seedProfile() (replay engine, setup complete, the
// workspace root already pointed at the sibling workspace dir), then opens the
// window maximized at the recording zoom (window-state.json + windowUi), materializes the
// ledger-cli fixture, commits it, and applies
// WORKING_TREE_EDIT so the IDE gutter has a modified hunk. Everything lives
// under a temp dir that cleanupDemoProfile() removes.

const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const { RECORDING, replayScriptPath: resolveReplayScriptPath } = require('./demo-scenes');
const { WORKING_TREE_EDIT, materialize } = require('./demo-fixture');

function runGit(workspace, args) {
  const result = childProcess.spawnSync('git', args, {
    cwd: workspace,
    stdio: 'pipe',
  });
  if (result.error || result.status !== 0) {
    const detail = result.error?.message || String(result.stderr || '').trim();
    throw new Error(`demo fixture git ${args.join(' ')} failed${detail ? `: ${detail}` : ''}`);
  }
}

function seedDemoProfile(scene, { recording = RECORDING } = {}) {
  const { base, profile, workspace } = require('../../capture-ui').seedProfile();
  // Maximized window (the app's full-screen look) and a raised app zoom so
  // the capture stays legible once scaled down for the README.
  fs.writeFileSync(
    path.join(profile, 'window-state.json'),
    JSON.stringify({
      version: 1,
      normalBounds: { x: 80, y: 60, width: 1600, height: 930 },
      isMaximized: recording.maximized === true,
      displayId: null,
      updatedAt: new Date().toISOString(),
    }, null, 2),
    'utf8'
  );
  const shellConfigPath = path.join(profile, 'shell-config.json');
  const shellConfig = JSON.parse(fs.readFileSync(shellConfigPath, 'utf8'));
  shellConfig.windowUi = { appZoomPercent: recording.appZoomPercent };
  fs.writeFileSync(shellConfigPath, JSON.stringify(shellConfig, null, 2), 'utf8');

  materialize(workspace);
  runGit(workspace, ['-c', 'core.autocrlf=false', 'init', '-q']);
  runGit(workspace, [
    '-c', 'core.autocrlf=false',
    '-c', 'user.name=Demo',
    '-c', 'user.email=demo@localhost',
    'add', '-A',
  ]);
  runGit(workspace, [
    '-c', 'core.autocrlf=false',
    '-c', 'user.name=Demo',
    '-c', 'user.email=demo@localhost',
    'commit', '-q', '-m', 'Initial ledger-cli',
  ]);

  const editPath = path.join(workspace, ...WORKING_TREE_EDIT.path.split('/'));
  const original = fs.readFileSync(editPath, 'utf8');
  const occurrences = original.split(WORKING_TREE_EDIT.find).length - 1;
  if (occurrences !== 1) {
    throw new Error(
      `demo fixture edit target ${WORKING_TREE_EDIT.path} must contain the expected text exactly once (found ${occurrences})`
    );
  }
  fs.writeFileSync(
    editPath,
    original.replace(WORKING_TREE_EDIT.find, WORKING_TREE_EDIT.replace),
    'utf8'
  );

  return {
    base,
    profile,
    workspace,
    replayScriptPath: resolveReplayScriptPath(scene),
  };
}

function cleanupDemoProfile({ base }) {
  try {
    fs.rmSync(base, { recursive: true, force: true });
  } catch (_error) {
    // Windows can briefly retain Electron log handles; the temp directory is harmless.
  }
}

module.exports = { seedDemoProfile, cleanupDemoProfile };
