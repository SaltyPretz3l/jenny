const fs = require('fs');
const os = require('os');
const path = require('path');
const { Buffer } = require('buffer');

const LOG_TAIL_CHUNK_BYTES = 4096;

function readSidecarLogTail({
  homeDir = os.homedir(),
  fsImpl = fs,
  maxLines = 50,
} = {}) {
  const logPath = path.join(homeDir, '.companion', 'logs', 'sidecar.log');
  const normalizedMaxLines = Math.max(Number(maxLines) || 0, 1);
  let fileDescriptor = null;
  try {
    if (
      typeof fsImpl.openSync !== 'function'
      || typeof fsImpl.fstatSync !== 'function'
      || typeof fsImpl.readSync !== 'function'
      || typeof fsImpl.closeSync !== 'function'
    ) {
      const raw = fsImpl.readFileSync(logPath, 'utf8');
      const lines = String(raw || '')
        .split(/\r?\n/)
        .filter((line) => line.trim().length > 0);
      return lines.slice(-normalizedMaxLines).join('\n');
    }
    fileDescriptor = fsImpl.openSync(logPath, 'r');
    const stats = fsImpl.fstatSync(fileDescriptor);
    let position = Math.max(Number(stats?.size) || 0, 0);
    const chunks = [];
    let nonEmptyLines = 0;
    let lineHasContent = false;
    while (position > 0) {
      const readSize = Math.min(LOG_TAIL_CHUNK_BYTES, position);
      position -= readSize;
      const chunk = Buffer.alloc(readSize);
      const bytesRead = fsImpl.readSync(fileDescriptor, chunk, 0, readSize, position);
      if (bytesRead <= 0) {
        break;
      }
      chunks.unshift(chunk.subarray(0, bytesRead));
      for (let index = bytesRead - 1; index >= 0; index -= 1) {
        if (chunk[index] === 0x0a) {
          nonEmptyLines += lineHasContent ? 1 : 0;
          lineHasContent = false;
        } else if (![0x09, 0x0b, 0x0c, 0x0d, 0x20].includes(chunk[index])) {
          lineHasContent = true;
        }
      }
      if (nonEmptyLines >= normalizedMaxLines) {
        break;
      }
    }
    return Buffer.concat(chunks).toString('utf8')
      .split(/\r?\n/)
      .filter((line) => line.trim().length > 0)
      .slice(-normalizedMaxLines)
      .join('\n');
  } catch (_error) {
    return '';
  } finally {
    if (fileDescriptor !== null) {
      try {
        fsImpl.closeSync(fileDescriptor);
      } catch (_closeError) {
        // best effort
      }
    }
  }
}

function normalizeCrashDetail(detail) {
  const normalized = String(detail || '').trim();
  return normalized || 'The sidecar exited without a detailed reason.';
}

async function showSidecarCrashDialog({
  dialogImpl,
  ownerWindow,
  detail = '',
  appVersion = '',
  logTail = readSidecarLogTail(),
} = {}) {
  const detailParts = [
    String(appVersion || '').trim() ? `App version: ${String(appVersion).trim()}` : '',
    normalizeCrashDetail(detail),
    logTail ? `Recent sidecar log lines:\n${logTail}` : '',
  ].filter(Boolean);
  return dialogImpl.showMessageBox(ownerWindow, {
    type: 'error',
    title: 'Jenny Background Runtime Stopped',
    message: "Jenny's managed sidecar exited unexpectedly.",
    detail: detailParts.join('\n\n'),
    buttons: ['OK'],
    defaultId: 0,
    noLink: true,
  });
}

module.exports = {
  normalizeCrashDetail,
  readSidecarLogTail,
  showSidecarCrashDialog,
};
