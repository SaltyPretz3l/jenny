'use strict';

const path = require('path');
const { fileURLToPath } = require('node:url');

const IPC_SENDER_UNAUTHORIZED = 'ipc_sender_unauthorized';
const MAIN_DOCUMENT_PATH = path.resolve(__dirname, '..', '..', 'index.html');

function localPathIdentity(rawPath) {
  const value = typeof rawPath === 'string' ? rawPath.trim() : '';
  if (!value || !path.isAbsolute(value)) return '';
  const normalized = path.normalize(value);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function trustedMainFrameUrl(rawUrl, expectedDocumentPath = MAIN_DOCUMENT_PATH) {
  try {
    const parsed = new URL(String(rawUrl || ''));
    if (parsed.protocol !== 'file:') return false;
    const expected = localPathIdentity(expectedDocumentPath);
    const candidate = localPathIdentity(fileURLToPath(parsed));
    return expected !== '' && candidate === expected;
  } catch (_error) {
    return false;
  }
}

function senderReason(event, expectedWindow, expectedDocumentPath = MAIN_DOCUMENT_PATH) {
  if (!expectedWindow || expectedWindow.isDestroyed?.() === true) return 'window_unavailable';
  const expected = expectedWindow.webContents;
  const sender = event?.sender;
  if (!expected || expected.isDestroyed?.() === true) return 'window_contents_unavailable';
  if (!sender || sender.isDestroyed?.() === true) return 'sender_unavailable';
  if (sender !== expected) return 'foreign_sender';
  if (!event.senderFrame || !expected.mainFrame || event.senderFrame !== expected.mainFrame) {
    return 'foreign_frame';
  }
  try {
    if (!trustedMainFrameUrl(sender.getURL?.(), expectedDocumentPath)
      || !trustedMainFrameUrl(event.senderFrame.url, expectedDocumentPath)) {
      return 'untrusted_navigation';
    }
  } catch (_error) {
    return 'untrusted_navigation';
  }
  return '';
}

function createTrustedSenderAuthorizer({
  getMainWindow,
  expectedDocumentPath = MAIN_DOCUMENT_PATH,
  log = null,
} = {}) {
  const logger = typeof log === 'function' ? log : null;
  const documentPath = localPathIdentity(expectedDocumentPath);
  return (event, metadata = {}) => {
    let expectedWindow = null;
    try {
      expectedWindow = typeof getMainWindow === 'function' ? getMainWindow() : null;
    } catch (_error) {
      /* fail closed below */
    }
    const reason = senderReason(event, expectedWindow, documentPath);
    if (!reason) return true;
    try {
      logger?.('WARN', 'ipc.sender_rejected', {
        reason,
        method: String(metadata.methodPath || '').slice(0, 80),
        senderId: Number.isSafeInteger(event?.sender?.id) ? event.sender.id : null,
      });
    } catch (_error) {
      /* diagnostics cannot change authorization */
    }
    return false;
  };
}

function unauthorizedIpcResult() {
  return {
    ok: false,
    authorized: false,
    code: IPC_SENDER_UNAUTHORIZED,
  };
}

module.exports = {
  IPC_SENDER_UNAUTHORIZED,
  MAIN_DOCUMENT_PATH,
  createTrustedSenderAuthorizer,
  senderReason,
  trustedMainFrameUrl,
  unauthorizedIpcResult,
};
