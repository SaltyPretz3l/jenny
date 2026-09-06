/* overlay-window.js — transparent comet overlay companion BrowserWindow (default-off). */
const { BrowserWindow } = require('electron');
const path = require('path');

function createCometOverlay(mainWindow, { onDispose = () => {} } = {}) {
  const overlay = new BrowserWindow({
    width: 120,
    height: 120,
    show: false,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    focusable: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload-overlay.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  overlay.setIgnoreMouseEvents(true, { forward: true });
  overlay.loadFile(path.join(__dirname, 'overlay.html'));

  /* Position near bottom-right of main window */
  function repositionOverlay() {
    if (overlay.isDestroyed()) return;
    var mainBounds = mainWindow.getBounds();
    overlay.setPosition(
      mainBounds.x + mainBounds.width - 140,
      mainBounds.y + mainBounds.height - 140
    );
  }

  /* Store handler refs for selective removal */
  var _onMove = repositionOverlay;
  var _onResize = repositionOverlay;
  var _onFocus = function () { if (!overlay.isDestroyed()) overlay.hide(); };
  var _onBlur = function () { if (!overlay.isDestroyed()) overlay.showInactive(); };
  var disposed = false;

  function cleanupOwnerListeners() {
    mainWindow.removeListener('move', _onMove);
    mainWindow.removeListener('resize', _onResize);
    mainWindow.removeListener('focus', _onFocus);
    mainWindow.removeListener('blur', _onBlur);
    mainWindow.removeListener('closed', _onClosed);
  }

  function finalizeDispose() {
    if (disposed) {
      return;
    }
    disposed = true;
    cleanupOwnerListeners();
    onDispose();
  }

  function dispose() {
    if (disposed) {
      return;
    }
    let finalizeError = null;
    try {
      finalizeDispose();
    } catch (error) {
      finalizeError = error;
    }
    if (!overlay.isDestroyed()) overlay.destroy();
    if (finalizeError) {
      throw finalizeError;
    }
  }

  var _onClosed = function () { dispose(); };

  mainWindow.on('move', _onMove);
  mainWindow.on('resize', _onResize);
  mainWindow.on('focus', _onFocus);
  mainWindow.on('blur', _onBlur);
  mainWindow.on('closed', _onClosed);
  overlay.on('closed', finalizeDispose);
  repositionOverlay();
  if (!mainWindow.isFocused()) overlay.showInactive();

  return {
    window: overlay,
    dispose,
  };
}

module.exports = {
  createCometOverlay,
};
