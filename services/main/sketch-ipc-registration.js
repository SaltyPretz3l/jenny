'use strict';

// sketch.openFile IPC (row 149, plan PROJECT_BOARD_2026-11-13 section 5.6): a drawing's file node asks whether the
// path it names may open. services/sketch/sketch-file-open.js decides against the session's own project root; the
// renderer then opens the relative path through the Workspace's existing open path, which reads the file.
//
// Always registered, behind the trusted-sender authorizer. Every call resolves, to { ok: true, relativePath, line,
// projectId } or { ok: false, reason }; with the `sketch_blocks` flag off it answers `disabled` before any check.
// The log line carries the reason code only, never the path, the session or a file name. Desktop only.

const { registerIpcInvokeHandlers } = require('../ipc-contract');
const { REASONS, createSketchFileOpener } = require('../sketch/sketch-file-open');

const REASON_SET = new Set(REASONS);
const refuse = (reason) => ({ ok: false, reason });

function isSketchBlocksEnabled(backendService) {
  return backendService?.featureFlags?.sketch_blocks !== false;
}

function captureSessionOf(backendService) {
  return (sessionId) => {
    const authority = backendService?.projectAuthority;
    if (!authority || typeof authority.captureSession !== 'function') {
      const error = new Error('Session was not found.');
      error.reason = 'session_not_found';
      throw error;
    }
    return authority.captureSession(sessionId);
  };
}

// Only a relative path with forward slashes and no `..` leaves the main process, whatever the check returned.
function safeAnswer(answer) {
  if (answer && answer.ok === true) {
    const relativePath = typeof answer.relativePath === 'string' ? answer.relativePath : '';
    const plain = relativePath && !/^[\\/]|^[A-Za-z]:|\\|(^|\/)\.\.(\/|$)/.test(relativePath);
    if (!plain || typeof answer.projectId !== 'string' || !answer.projectId) return refuse('not_found');
    return { ok: true, relativePath, line: Number.isInteger(answer.line) ? answer.line : null, projectId: answer.projectId };
  }
  return refuse(answer && REASON_SET.has(answer.reason) ? answer.reason : 'not_found');
}

function registerSketchIpc(ipcMain, {
  backendService,
  authorization,
  log = () => {},
  isEnabled = () => isSketchBlocksEnabled(backendService),
  openFile = createSketchFileOpener({ captureSession: captureSessionOf(backendService), isEnabled: () => true }),
}) {
  const channels = registerIpcInvokeHandlers(ipcMain, {
    'sketch.openFile': async (_event, raw) => {
      let answer;
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        answer = refuse('no_session');
      } else if (!isEnabled()) {
        answer = refuse('disabled');
      } else {
        try {
          answer = safeAnswer(await openFile({ sessionId: raw.sessionId, path: raw.path, line: raw.line }));
        } catch {
          answer = refuse('not_found');
        }
      }
      try { log('INFO', 'sketch.open_file', { reason: answer.ok ? 'ok' : answer.reason }); } catch { /* best effort */ }
      return answer;
    },
  }, authorization);
  return { channels };
}

module.exports = { isSketchBlocksEnabled, registerSketchIpc };
