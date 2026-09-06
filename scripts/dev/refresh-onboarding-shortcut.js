'use strict';

/**
 * scripts/dev/refresh-onboarding-shortcut.js
 *
 * Creates / refreshes the "Jenny Onboarding Demo" desktop shortcut (Windows).
 * Idempotent and best-effort: it rewrites the .lnk to point at the current repo
 * location and the current Electron icon, so the shortcut self-heals if the repo
 * moves or Electron updates.
 *
 * Two entry points:
 *   - `node scripts/dev/refresh-onboarding-shortcut.js`  (verbose, standalone)
 *   - imported by run-onboarding-demo.js, which calls it on every demo run.
 *
 * The real Desktop folder is resolved via [Environment]::GetFolderPath('Desktop')
 * inside PowerShell, so OneDrive desktop redirection is handled automatically.
 */

const { spawnSync } = require('node:child_process');
const path = require('node:path');

const SHORTCUT_NAME = 'Jenny Onboarding Demo.lnk';

// Single-quote a value for inlining into a PowerShell command. PowerShell single
// quotes are literal (no backslash escaping), so only embedded quotes need doubling.
function psSingleQuote(value) {
  return "'" + String(value).replace(/'/g, "''") + "'";
}

function resolveIconPath(repoRoot) {
  try {
    // The electron npm package's entry point is the path to electron.exe when
    // required outside of an Electron process.
    const electronEntry = require('electron');
    if (typeof electronEntry === 'string' && electronEntry) {
      return electronEntry;
    }
  } catch (_error) {
    // fall through to the conventional dist path
  }
  return path.join(repoRoot, 'node_modules', 'electron', 'dist', 'electron.exe');
}

function refreshOnboardingShortcut(repoRoot) {
  if (process.platform !== 'win32') {
    return { ok: false, reason: 'not-windows' };
  }
  const root = repoRoot || path.join(__dirname, '..', '..');
  const comSpec = process.env.ComSpec || 'cmd.exe';
  // WorkingDirectory supplies the repo context; `|| pause` keeps the window open on failure.
  const args = '/c "npm run demo:onboarding || pause"';
  const icon = resolveIconPath(root) + ',0';
  const script = [
    '$ErrorActionPreference = "Stop";',
    "$desktop = [Environment]::GetFolderPath('Desktop');",
    '$path = Join-Path $desktop ' + psSingleQuote(SHORTCUT_NAME) + ';',
    '$s = New-Object -ComObject WScript.Shell;',
    '$lnk = $s.CreateShortcut($path);',
    '$lnk.TargetPath = ' + psSingleQuote(comSpec) + ';',
    '$lnk.Arguments = ' + psSingleQuote(args) + ';',
    '$lnk.WorkingDirectory = ' + psSingleQuote(root) + ';',
    '$lnk.IconLocation = ' + psSingleQuote(icon) + ';',
    '$lnk.Description = '
      + psSingleQuote('Jenny onboarding demo — manual first-run walkthrough (no downloads, real hardware scan).') + ';',
    '$lnk.Save();',
    'Write-Output $path;',
  ].join(' ');
  const result = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
    { encoding: 'utf8' }
  );
  if (result.error || result.status !== 0) {
    return {
      ok: false,
      reason: (result.error && result.error.message) || ('exit ' + String(result.status)),
    };
  }
  return { ok: true, lnkPath: String(result.stdout || '').trim() };
}

module.exports = { refreshOnboardingShortcut };

if (require.main === module) {
  const res = refreshOnboardingShortcut(path.join(__dirname, '..', '..'));
  if (res.ok) {
    console.log('Refreshed desktop shortcut -> ' + res.lnkPath);
  } else if (res.reason === 'not-windows') {
    console.log('Skipped: desktop shortcut is Windows-only.');
  } else {
    console.warn('Could not refresh desktop shortcut: ' + res.reason);
    process.exitCode = 1;
  }
}
