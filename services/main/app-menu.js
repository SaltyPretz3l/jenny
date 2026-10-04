'use strict';

// The application menu Jenny installs instead of Electron's default one.
//
// Electron's default menu carries View > Reload (Ctrl+R) and Force Reload
// (Ctrl+Shift+R) as accelerators that fire in the main process, ahead of any
// renderer keydown handling. On a frameless window with the menu bar hidden
// they are invisible yet still live, so Ctrl+R reloaded the renderer past the
// dirty-buffer preflight the guarded reload runs (shell-chrome review, 2026-09-29).
// This menu keeps what the platform needs (edit roles for clipboard shortcuts,
// the macOS app and window menus) and, in development only, a DevTools toggle.
// No reload roles anywhere: reload is the renderer's guarded entry point.

function buildApplicationMenuTemplate({ platform = process.platform, isPackaged = true } = {}) {
  const template = [];
  if (platform === 'darwin') template.push({ role: 'appMenu' });
  template.push({ role: 'editMenu' });
  if (platform === 'darwin') template.push({ role: 'windowMenu' });
  if (!isPackaged) {
    template.push({ label: 'Developer', submenu: [{ role: 'toggleDevTools' }] });
  }
  return template;
}

function installApplicationMenu({ Menu, platform, isPackaged, log = () => {} } = {}) {
  if (!Menu || typeof Menu.buildFromTemplate !== 'function' || typeof Menu.setApplicationMenu !== 'function') {
    return null;
  }
  const template = buildApplicationMenuTemplate({ platform, isPackaged });
  try {
    Menu.setApplicationMenu(Menu.buildFromTemplate(template));
    return template;
  } catch (error) {
    try {
      log('WARN', 'window.menu_install_failed', { message: String(error?.message || error) });
    } catch (_) {
      // logging must never throw
    }
    return null;
  }
}

module.exports = { buildApplicationMenuTemplate, installApplicationMenu };
