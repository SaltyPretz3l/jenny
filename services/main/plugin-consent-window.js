'use strict';

const crypto = require('node:crypto');
const path = require('node:path');

const INIT_CHANNEL = 'plugin-consent:initialize';
const DECIDE_CHANNEL = 'plugin-consent:decide';

class PluginConsentWindow {
  constructor({ BrowserWindow, ipcMain, session, baseDir, timeoutMs = 120_000, log = () => {} } = {}) {
    this._BrowserWindow = BrowserWindow;
    this._ipc = ipcMain;
    this._session = session;
    this._baseDir = baseDir;
    this._timeout = timeoutMs;
    this._log = typeof log === 'function' ? log : () => {};
    this._active = null;
    this._epoch = 0;
  }

  openPrompt(model) {
    if (this._active) return Promise.resolve({ approved: false, reason: 'busy' });
    const openedAt = Date.now();
    this._log('INFO', 'plugins.consent_window_opened', {
      operation: String(model?.operation || '').slice(0, 64),
      contribution_id: String(model?.contribution || '').slice(0, 120),
    });
    this._epoch += 1;
    const epoch = this._epoch;
    const nonce = crypto.randomBytes(24).toString('hex');
    const partition = `plugin-consent-${crypto.randomBytes(12).toString('hex')}`;
    const isolatedSession = this._session.fromPartition(partition, { cache: false });
    isolatedSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
    isolatedSession.setPermissionCheckHandler(() => false);
    isolatedSession.on('will-download', (event) => event.preventDefault());
    const win = new this._BrowserWindow({
      width: 500, height: 768, minWidth: 440, minHeight: 640, useContentSize: true, show: false,
      backgroundColor: '#0b101b', autoHideMenuBar: true,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false,
        devTools: false, partition, preload: path.join(this._baseDir, 'plugin-consent-preload.bundle.js') },
    });
    const trustedFile = path.join(this._baseDir, 'plugin-consent.html');
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', (event, url) => { if (url !== `file://${trustedFile.replaceAll('\\', '/')}`) event.preventDefault(); });
    return new Promise((resolve) => {
      let settled = false;
      const settle = async (decision) => {
        if (settled) return;
        settled = true;
        this._log('INFO', 'plugins.consent_window_settled', {
          status: decision?.approved === true ? 'approved' : 'denied',
          reason_code: String(decision?.reason || (decision?.approved === true ? 'approved' : 'denied')).slice(0, 64),
          contribution_id: String(model?.contribution || '').slice(0, 120),
          acknowledged: decision?.acknowledged === true,
          duration_ms: Math.max(0, Date.now() - openedAt),
        });
        clearTimeout(timer);
        this._ipc.removeHandler(INIT_CHANNEL);
        this._ipc.removeHandler(DECIDE_CHANNEL);
        this._active = null;
        try { if (!win.isDestroyed()) win.destroy(); } catch (_error) { /* deny already settled */ }
        try { await isolatedSession.clearStorageData(); } catch (_error) { /* ephemeral partition */ }
        resolve(decision);
      };
      const authorized = (event) => event.sender === win.webContents && event.senderFrame === win.webContents.mainFrame
        && epoch === this._epoch && !win.isDestroyed();
      this._ipc.handle(INIT_CHANNEL, (event) => authorized(event)
        ? { ok: true, nonce, epoch, model } : { ok: false, reason: 'unauthorized' });
      this._ipc.handle(DECIDE_CHANNEL, (event, payload) => {
        if (!authorized(event) || payload?.nonce !== nonce || payload?.epoch !== epoch
          || typeof payload?.approved !== 'boolean' || typeof payload?.acknowledged !== 'boolean') {
          return { ok: false, reason: 'unauthorized' };
        }
        void settle({ approved: payload.approved, acknowledged: payload.acknowledged });
        return { ok: true };
      });
      const timer = setTimeout(() => void settle({ approved: false, reason: 'timeout' }), this._timeout);
      win.once('closed', () => void settle({ approved: false, reason: 'closed' }));
      win.webContents.once('render-process-gone', () => void settle({ approved: false, reason: 'renderer_gone' }));
      win.webContents.once('did-fail-load', () => void settle({ approved: false, reason: 'load_failed' }));
      win.once('ready-to-show', () => win.show());
      this._active = { win, settle };
      win.loadFile(trustedFile).catch(() => settle({ approved: false, reason: 'load_failed' }));
    });
  }

  close() { if (this._active) void this._active.settle({ approved: false, reason: 'shutdown' }); }
}

module.exports = { INIT_CHANNEL, DECIDE_CHANNEL, PluginConsentWindow };
