// Pure, dependency-injected helpers for the versioned scheduled_tasks.json
// store; SchedulerService re-exports the public helpers.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { normalizeString } = require('../renderer/shared/string-utils');
const { safeEmitLog } = require('./backend/session-store-logging');
const {
  SCHEDULED_TASKS_SCHEMA_VERSION,
} = require('./scheduler-schema-version');
const {
  normalizeScheduledTasks,
} = require('./scheduler-task-registry');

const TERMINAL_AUTOMATION_STATUSES = new Set(['completed', 'failed', 'cancelled', 'skipped']);

function defaultIsProcessAlive(pid) {
  const normalizedPid = Number(pid);
  if (!Number.isInteger(normalizedPid) || normalizedPid <= 0) {
    return false;
  }
  try {
    process.kill(normalizedPid, 0);
    return true;
  } catch (error) {
    if (error?.code === 'EPERM') {
      return true;
    }
    return false;
  }
}

function resolveBackgroundRuntimeRoot(userDataPath) {
  return path.join(String(userDataPath || ''), 'background-memory');
}

function resolveScheduledTasksPath({
  workspaceRoot,
  userDataPath,
  backgroundRuntimeRoot = '',
} = {}) {
  const normalizedWorkspaceRoot = normalizeString(workspaceRoot);
  if (normalizedWorkspaceRoot) {
    return path.join(normalizedWorkspaceRoot, '.jenny', 'scheduled_tasks.json');
  }
  const runtimeRoot = normalizeString(backgroundRuntimeRoot) || resolveBackgroundRuntimeRoot(userDataPath);
  return path.join(runtimeRoot, 'scheduled_tasks.json');
}

function parseIsoMs(value) {
  const token = normalizeString(value);
  if (!token) {
    return 0;
  }
  const parsed = Date.parse(token);
  return Number.isFinite(parsed) ? parsed : 0;
}

function isTerminalAutomationStatus(status) {
  return TERMINAL_AUTOMATION_STATUSES.has(status);
}

function normalizeScheduledTasksVersion(value) {
  const version = Number(value || 1);
  return Number.isFinite(version) ? version : 1;
}

function getScheduledTasksVersion(payload) {
  const source = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};
  return normalizeScheduledTasksVersion(source.version);
}

function hasNewerScheduledTasksVersion(payload) {
  return getScheduledTasksVersion(payload) > SCHEDULED_TASKS_SCHEMA_VERSION;
}

function readScheduledTasksJsonPayload(tasksPath, { fsImpl = fs } = {}) {
  try {
    const raw = fsImpl.readFileSync(tasksPath, 'utf8');
    return JSON.parse(raw);
  } catch (_error) {
    return null;
  }
}

function readFileUtf8Async(filePath, { fsImpl = fs } = {}) {
  if (typeof fsImpl?.promises?.readFile === 'function') {
    return fsImpl.promises.readFile(filePath, 'utf8');
  }
  if (typeof fsImpl?.readFile === 'function') {
    return new Promise((resolve, reject) => {
      fsImpl.readFile(filePath, 'utf8', (error, raw) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(raw);
      });
    });
  }
  return Promise.resolve().then(() => fsImpl.readFileSync(filePath, 'utf8'));
}

function safeLogScheduledTasksVersion(logger, event, tasksPath, observedVersion) {
  safeEmitLog(logger, 'WARN', event, {
    tasksPath,
    observedVersion,
    expectedVersion: SCHEDULED_TASKS_SCHEMA_VERSION,
  });
}

function readScheduledTasksFile(
  tasksPath,
  { fsImpl = fs, logger = null, nowProvider = () => new Date() } = {}
) {
  try {
    const raw = fsImpl.readFileSync(tasksPath, 'utf8');
    const payload = JSON.parse(raw);
    if (hasNewerScheduledTasksVersion(payload)) {
      safeLogScheduledTasksVersion(
        logger,
        'scheduler.tasks_newer_schema_detected',
        tasksPath,
        getScheduledTasksVersion(payload)
      );
      return normalizeScheduledTasks({}, nowProvider());
    }
    return normalizeScheduledTasks(payload, nowProvider());
  } catch (_error) {
    return normalizeScheduledTasks({}, nowProvider());
  }
}

async function readScheduledTasksFileAsync(
  tasksPath,
  { fsImpl = fs, logger = null, nowProvider = () => new Date() } = {}
) {
  try {
    const raw = await readFileUtf8Async(tasksPath, { fsImpl });
    const payload = JSON.parse(raw);
    if (hasNewerScheduledTasksVersion(payload)) {
      safeLogScheduledTasksVersion(
        logger,
        'scheduler.tasks_newer_schema_detected',
        tasksPath,
        getScheduledTasksVersion(payload)
      );
      return normalizeScheduledTasks({}, nowProvider());
    }
    return normalizeScheduledTasks(payload, nowProvider());
  } catch (_error) {
    return normalizeScheduledTasks({}, nowProvider());
  }
}

function writeScheduledTasksFile(tasksPath, payload, { fsImpl = fs } = {}) {
  const dirPath = path.dirname(tasksPath);
  fsImpl.mkdirSync(dirPath, { recursive: true });
  const tempPath = `${tasksPath}.${Date.now()}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  try {
    fsImpl.writeFileSync(tempPath, JSON.stringify(payload, null, 2), 'utf8');
    fsImpl.renameSync(tempPath, tasksPath);
  } catch (error) {
    try {
      fsImpl.unlinkSync(tempPath);
    } catch (_cleanupError) {
      // Best effort cleanup of a failed temp file write.
    }
    throw error;
  }
}

module.exports = {
  TERMINAL_AUTOMATION_STATUSES,
  defaultIsProcessAlive,
  resolveBackgroundRuntimeRoot,
  resolveScheduledTasksPath,
  parseIsoMs,
  isTerminalAutomationStatus,
  normalizeScheduledTasksVersion,
  getScheduledTasksVersion,
  hasNewerScheduledTasksVersion,
  readScheduledTasksJsonPayload,
  readFileUtf8Async,
  safeLogScheduledTasksVersion,
  readScheduledTasksFile,
  readScheduledTasksFileAsync,
  writeScheduledTasksFile,
};
