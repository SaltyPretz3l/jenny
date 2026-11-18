'use strict';

/* services/terminal-start-folder.js - where the Jenny chat's terminal_run starts its shell (2026-11-17 install-session
 * review, owner pick: a terminal of its own in a folder the user controls, defaulting to the Downloads folder).
 *
 * The folder is the Settings > Editor > Terminal "Start folder for Jenny's commands" preference
 * (workspaceIde.preferences.terminalStartFolder) when it names an existing local folder, else the user's Downloads
 * folder. A chosen folder that has gone missing falls back to Downloads rather than refusing: the approval card names
 * the folder the command will actually run in, so the user sees the fallback before anything runs. Main resolves it;
 * the renderer only ever sends the closed word 'start_folder', never a path.
 */

const fs = require('node:fs');
const path = require('node:path');

const MAX_FOLDER_CHARS = 512;

// A local absolute folder path: no NUL, bounded, absolute, and not a network (UNC) path.
function cleanTerminalStartFolder(value) {
  if (typeof value !== 'string') return '';
  const text = value.trim();
  if (!text || text.length > MAX_FOLDER_CHARS || text.includes('\0')) return '';
  if (/^[\\/]{2}/.test(text)) return '';
  return path.isAbsolute(text) ? text : '';
}

function readText(getter) {
  try { return String(getter() || ''); } catch (_error) { return ''; }
}

function existingFolder(candidate, fsImpl) {
  const folder = cleanTerminalStartFolder(candidate);
  if (!folder) return '';
  try {
    const real = fsImpl.realpathSync(folder);
    return cleanTerminalStartFolder(real) && fsImpl.statSync(real).isDirectory() ? real : '';
  } catch (_error) {
    return '';
  }
}

/**
 * `{ ok: true, folder, source: 'setting' | 'downloads' }` or `{ ok: false, reason: 'start_folder_unavailable' }`.
 * `preference` is the stored setting ('' = Downloads); `downloadsDir` returns the OS Downloads folder.
 */
function resolveTerminalStartFolder({ preference = () => '', downloadsDir = () => '', fsImpl = fs } = {}) {
  const fromSetting = existingFolder(readText(preference), fsImpl);
  if (fromSetting) return { ok: true, folder: fromSetting, source: 'setting' };
  const fromDownloads = existingFolder(readText(downloadsDir), fsImpl);
  if (fromDownloads) return { ok: true, folder: fromDownloads, source: 'downloads' };
  return { ok: false, reason: 'start_folder_unavailable' };
}

// The stored preference, read defensively from the shell config state.
function terminalStartFolderPreference(configService) {
  try {
    const state = configService?.getState?.() || {};
    return cleanTerminalStartFolder(state.workspaceIde?.preferences?.terminalStartFolder);
  } catch (_error) {
    return '';
  }
}

// The resolver main hands to the terminal tools (the card) and the pty service (the spawn): one rule, two callers.
// `config` returns the shell config service; `downloadsDir` returns the OS Downloads folder.
function createTerminalStartFolder({ config = () => null, downloadsDir = () => '', fsImpl = fs } = {}) {
  return () => resolveTerminalStartFolder({ preference: () => terminalStartFolderPreference(config()), downloadsDir, fsImpl });
}

module.exports = {
  cleanTerminalStartFolder,
  createTerminalStartFolder,
  resolveTerminalStartFolder,
  terminalStartFolderPreference,
};
