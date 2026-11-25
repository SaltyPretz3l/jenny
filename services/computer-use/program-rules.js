'use strict';

/* services/computer-use/program-rules.js: which programs computer use may touch (row 196).
 *
 * Three kinds, decided from the real program's file as the helper's `program.identify` names it (a
 * Store app's frame is never what is judged):
 * - never: a way to run anything or to change the system, and Jenny itself. Never granted, never looked
 *   at. Everything under the Windows folder is here unless it is on a short allowlist, because Settings,
 *   Explorer, Task Manager, the registry, the consoles, the script and installer hosts all live there.
 * - view_only: web browsers and terminals (owner decisions D3 and D4). A grant lets Jenny see the window;
 *   the helper is never asked to click or type in it.
 * - grantable: everything else, asked for program by program.
 * A path that cannot be judged (empty, relative, not a program file) is `never`: every caller fails closed.
 * The helper refuses Jenny's processes and the never list again at the moment of input (`deny_programs`),
 * so a mistake here is caught twice. */

const path = require('node:path');

// Under the Windows folder, only these may be granted.
const WINDOWS_ALLOWLIST = new Set(['notepad.exe', 'mspaint.exe', 'charmap.exe', 'write.exe']);
// Under the Windows folder, the classic consoles, which are terminals: view only (D4), never driven.
const WINDOWS_VIEW_ONLY = new Set(['conhost.exe', 'cmd.exe', 'powershell.exe']);

// Outside the Windows folder, programs that run anything or hold secrets.
const NEVER_NAMES = new Set([
  // Jenny, any instance and any build.
  'jenny.exe',
  // Script, installer and code hosts.
  'python.exe', 'pythonw.exe', 'py.exe', 'pyw.exe', 'node.exe', 'deno.exe', 'bun.exe',
  'autohotkey.exe', 'autohotkey32.exe', 'autohotkey64.exe', 'autohotkeyux.exe',
  'bash.exe', 'sh.exe', 'git-bash.exe', 'mintty.exe', 'msiexec.exe', 'setup.exe', 'install.exe',
  // Password managers.
  '1password.exe', 'keepass.exe', 'keepassxc.exe', 'bitwarden.exe', 'dashlane.exe', 'lastpass.exe',
  'enpass.exe', 'roboform.exe', 'nordpass.exe', 'proton pass.exe',
]);

// Web browsers and terminals: looked at, never driven.
const VIEW_ONLY_NAMES = new Set([
  'chrome.exe', 'msedge.exe', 'firefox.exe', 'brave.exe', 'opera.exe', 'opera_gx.exe', 'vivaldi.exe',
  'arc.exe', 'iexplore.exe', 'librewolf.exe', 'waterfox.exe', 'thorium.exe', 'chromium.exe',
  'windowsterminal.exe', 'wt.exe', 'openconsole.exe', 'pwsh.exe', 'alacritty.exe', 'wezterm-gui.exe',
  'hyper.exe', 'tabby.exe', 'conemu.exe', 'conemu64.exe', 'cmder.exe', 'kitty.exe', 'putty.exe',
]);

const KINDS = Object.freeze(['never', 'view_only', 'grantable']);

/** The same file whatever the spelling: lower case, back slashes, no `\\?\` prefix. */
function normalizeProgramPath(value) {
  let text = String(value || '').trim().replace(/\//g, '\\');
  if (text.toLowerCase().startsWith('\\\\?\\unc\\')) text = `\\\\${text.slice(8)}`;
  else if (text.startsWith('\\\\?\\')) text = text.slice(4);
  return text.toLowerCase();
}

function isUnder(file, folder) {
  if (!folder) return false;
  const root = normalizeProgramPath(folder).replace(/\\+$/, '');
  return Boolean(root) && file.startsWith(`${root}\\`);
}

/**
 * The kind of one program file.
 * @param {string} programPath the real program's full path, as the helper named it
 * @param {object} [options]
 * @param {string} [options.windowsDir] the Windows folder (default `%SystemRoot%`, then `C:\Windows`)
 * @param {string[]} [options.jennyPrograms] Jenny's own program files (this instance's `process.execPath`)
 * @returns {'never'|'view_only'|'grantable'}
 */
function programKind(programPath, { windowsDir, jennyPrograms = [] } = {}) {
  const file = normalizeProgramPath(programPath);
  if (!/^(?:[a-z]:\\|\\\\[^\\]+\\[^\\]+\\)/.test(file) || !file.endsWith('.exe')) return 'never';
  if (file.split('\\').some((part) => part === '..' || part === '.')) return 'never';
  const name = path.win32.basename(file);
  if (jennyPrograms.some((jenny) => normalizeProgramPath(jenny) === file)) return 'never';
  if (NEVER_NAMES.has(name)) return 'never';
  const windows = windowsDir || process.env.SystemRoot || 'C:\\Windows';
  if (isUnder(file, windows)) {
    if (WINDOWS_VIEW_ONLY.has(name)) return 'view_only';
    if (!WINDOWS_ALLOWLIST.has(name)) return 'never';
  }
  if (VIEW_ONLY_NAMES.has(name)) return 'view_only';
  return 'grantable';
}

/** May the helper send input to a program of this kind? Only a granted, grantable program. */
function allowsInput(kind) {
  return kind === 'grantable';
}

module.exports = {
  KINDS,
  NEVER_NAMES,
  VIEW_ONLY_NAMES,
  WINDOWS_ALLOWLIST,
  WINDOWS_VIEW_ONLY,
  allowsInput,
  normalizeProgramPath,
  programKind,
};
