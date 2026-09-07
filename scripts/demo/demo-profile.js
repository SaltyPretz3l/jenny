'use strict';

// Throwaway profile + sample workspace for one demo clip recording.
//
// Builds on capture-ui.js seedProfile() (replay engine, setup complete, the
// workspace root already pointed at the sibling workspace dir), then opens the
// window maximized at the recording zoom (window-state.json + windowUi),
// materializes the ledger-cli fixture, commits it, applies WORKING_TREE_EDIT so
// the IDE gutter has a modified hunk, and seeds the history the clips are
// framed by (demo-sessions.js): past chats in the sidebar, written through the
// app's own session store; a week of calendar events; and an always-allow
// policy for the Home tool so the calendar clip's writes run without an
// approval stop. The scene's replay script is copied in with its relative
// date tokens resolved against `now`. Everything lives under a temp dir that
// cleanupDemoProfile() removes.

const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { ElectronSessionStore } = require('../../services/backend/electron-session-store');
const { ToolPermissionStore } = require('../../services/tools/tool-permission-store');
const { RECORDING, replayScriptPath: resolveReplayScriptPath } = require('./demo-scenes');
const { WORKING_TREE_EDIT, materialize } = require('./demo-fixture');
const { DEMO_MODEL, buildSeededSessions, buildSeededCalendarEvents } = require('./demo-sessions');
const { resolveDateTokens, localDateStamp } = require('./demo-dates');

const CALENDAR_STORE_FILE = 'home-calendar.json';
const CALENDAR_STORE_VERSION = 1;

// The sample project lives at a neutral, readable path rather than under the
// temp profile: the IDE terminal's prompt prints the workspace path, and a
// %TEMP% path would put the recording machine's user name into every clip.
function demoWorkspaceDir() {
  if (process.platform === 'win32') {
    return path.join(process.env.PUBLIC || 'C:\\Users\\Public', 'ledger-cli');
  }
  return path.join(os.tmpdir(), 'ledger-cli');
}

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

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf8');
}

// Past chats for the history sidebar. The store assigns ids and writes the
// current split layout; the timestamps it stamps are "now", so the seeded
// ages are patched into the flushed files afterwards (the sidebar groups by
// updated_at, the session by created_at).
function seedDemoSessions(profile, now = Date.now()) {
  const storePath = path.join(profile, 'sessions.json');
  const store = new ElectronSessionStore(storePath, { writeDebounceMs: 0 });
  const seeded = [];
  try {
    for (const entry of buildSeededSessions(now)) {
      const summary = store.createSession({ title: entry.title });
      if (!summary || !summary.id) {
        throw new Error(`demo profile: could not create seeded session "${entry.title}"`);
      }
      for (const message of entry.messages) {
        store.appendMessage(summary.id, message);
      }
      if (entry.pinned) {
        store.setSessionMeta(summary.id, { pinned: true });
      }
      seeded.push({ id: summary.id, entry });
    }
    store.flush();
  } finally {
    store.dispose();
  }

  const sessionsDir = path.join(profile, 'sessions');
  const indexPath = path.join(sessionsDir, '_index.json');
  const index = readJson(indexPath);
  for (const { id, entry } of seeded) {
    const stamps = {
      created_at: entry.createdAt,
      updated_at: entry.updatedAt,
      session_start_date: localDateStamp(new Date(entry.createdAt)),
      last_model_used: DEMO_MODEL,
    };
    const sessionPath = path.join(sessionsDir, `${id}.json`);
    const payload = readJson(sessionPath);
    Object.assign(payload.session, stamps);
    writeJson(sessionPath, payload);
    if (!index.sessions || !index.sessions[id]) {
      throw new Error(`demo profile: seeded session ${id} missing from the session index`);
    }
    Object.assign(index.sessions[id], stamps);
  }
  writeJson(indexPath, index);
  return seeded.map(({ id }) => id);
}

function seedDemoCalendar(profile, now = Date.now()) {
  writeJson(path.join(profile, CALENDAR_STORE_FILE), {
    version: CALENDAR_STORE_VERSION,
    events: buildSeededCalendarEvents(now),
  });
}

function seedDemoToolPolicy(profile) {
  const store = new ToolPermissionStore(path.join(profile, 'tool-permissions.json'));
  store.setPolicy('home', 'auto');
}

// The scene's replay script with its {{date+N}} / {{weekday+N}} tokens
// resolved, written next to the profile so the repo copy stays date-free.
function materializeReplayScript(scene, base, now) {
  const sourcePath = resolveReplayScriptPath(scene);
  if (!sourcePath) {
    return null;
  }
  const resolved = resolveDateTokens(fs.readFileSync(sourcePath, 'utf8'), now);
  JSON.parse(resolved); // a token must never break the script
  const targetPath = path.join(base, path.basename(sourcePath));
  fs.writeFileSync(targetPath, resolved, 'utf8');
  return targetPath;
}

function seedDemoProfile(scene, { recording = RECORDING, now = Date.now() } = {}) {
  const { base, profile } = require('../../capture-ui').seedProfile();
  const workspace = demoWorkspaceDir();
  fs.rmSync(workspace, { recursive: true, force: true });
  fs.mkdirSync(workspace, { recursive: true });
  // Maximized window (the app's full-screen look) at the recording zoom.
  writeJson(path.join(profile, 'window-state.json'), {
    version: 1,
    normalBounds: { x: 80, y: 60, width: 1600, height: 930 },
    isMaximized: recording.maximized === true,
    displayId: null,
    updatedAt: new Date(now).toISOString(),
  });
  const shellConfigPath = path.join(profile, 'shell-config.json');
  const shellConfig = readJson(shellConfigPath);
  shellConfig.windowUi = { appZoomPercent: recording.appZoomPercent };
  shellConfig.toolsWorkspaceRoot = workspace;
  writeJson(shellConfigPath, shellConfig);

  seedDemoSessions(profile, now);
  seedDemoCalendar(profile, now);
  seedDemoToolPolicy(profile);

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
    now,
    replayScriptPath: materializeReplayScript(scene, base, now),
  };
}

function cleanupDemoProfile({ base, workspace }) {
  for (const dir of [base, workspace]) {
    if (!dir) continue;
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch (_error) {
      // Windows can briefly retain Electron log handles; the leftover directory is harmless.
    }
  }
}

module.exports = {
  seedDemoProfile,
  cleanupDemoProfile,
  demoWorkspaceDir,
  seedDemoSessions,
  seedDemoCalendar,
  seedDemoToolPolicy,
  materializeReplayScript,
};
