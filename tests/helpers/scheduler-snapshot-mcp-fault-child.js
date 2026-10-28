'use strict';

// Child process for scheduler-snapshot-mcp-faults.test.js (rows T1, I1, X1, X4).
// Usage: node <this> <scheduler|snapshot|mcp-update|mcp-migrate> <dir> <kill-before|kill-after> <K>
//
// A test-only wrapper around the store's rename (fs.renameSync, or fs.promises.rename for
// the IDE snapshot store) SIGKILLs this process on the Kth rename whose destination matches
// the store's file: before the real rename (kill-before) or right after it returned
// (kill-after). An ack line is written only after the store call returned, so every acked
// value was durable before the kill. If the loop ends without the kill firing the child
// exits 0 and the test fails on that.

const fs = require('node:fs');
const fsPromises = require('node:fs/promises');
const path = require('node:path');

const { McpConfigStore, pendingTrust } = require('../../services/mcp-config-store');
const { normalizeScheduledTasks } = require('../../services/scheduler-task-registry');
const { writeScheduledTasksFile } = require('../../services/scheduler-tasks-store');
const { createWorkspaceIdeSnapshotStore } = require('../../services/workspace-ide-snapshot-store');

const FIXED_NOW = new Date('2026-10-26T00:00:00.000Z');

// Already normalized, so a read-back compares deep-equal with what was written.
function payloadFor(seq) {
  return normalizeScheduledTasks({
    tasks: [{
      id: `automation:fault_${seq}`,
      kind: 'automation',
      enabled: true,
      trigger: { type: 'interval', interval_seconds: 3600 + seq },
      input: { task_spec: `Run the read-only check number ${seq}.`, tool_grants: ['filesystem'] },
      automation_runs: [{ run_id: `run-${seq}`, status: 'completed', summary: `summary ${seq}` }],
      updated_at: '2026-10-25T00:00:00.000Z',
    }],
  }, FIXED_NOW);
}

function snapshotContentFor(seq) {
  return `line one\nsnapshot body number ${seq}\n`;
}

function mcpServerFor(seq) {
  const config = { name: `srv${seq}`, transport: 'stdio', command: 'node', args: [`server-${seq}.js`] };
  return { ...config, enabled: false, trust: pendingTrust(config) };
}

function mcpAddServer(seq) {
  return (document) => ({ ...document, mcp_servers: [...document.mcp_servers, mcpServerFor(seq)] });
}

function installSyncRenameKill(mode, killAt, targetName) {
  const real = fs.renameSync;
  let count = 0;
  fs.renameSync = function renameWithKill(from, to, ...rest) {
    if (path.basename(String(to)) !== targetName) return real.call(this, from, to, ...rest);
    count += 1;
    if (count !== killAt) return real.call(this, from, to, ...rest);
    if (mode === 'kill-before') process.kill(process.pid, 'SIGKILL');
    const result = real.call(this, from, to, ...rest);
    process.kill(process.pid, 'SIGKILL');
    return result;
  };
}

function installAsyncRenameKill(mode, killAt, extension) {
  const real = fsPromises.rename;
  let count = 0;
  fsPromises.rename = async function renameWithKill(from, to, ...rest) {
    if (!String(to).endsWith(extension)) return real.call(this, from, to, ...rest);
    count += 1;
    if (count !== killAt) return real.call(this, from, to, ...rest);
    if (mode === 'kill-before') process.kill(process.pid, 'SIGKILL');
    const result = await real.call(this, from, to, ...rest);
    process.kill(process.pid, 'SIGKILL');
    return result;
  };
}

function ack(text) {
  fs.writeSync(1, `${text}\n`);
}

async function main() {
  const [scenario, dir, mode, killAtText] = process.argv.slice(2);
  const killAt = Number(killAtText);
  if (!['scheduler', 'snapshot', 'mcp-update', 'mcp-migrate'].includes(scenario) || !dir
    || !['kill-before', 'kill-after'].includes(mode) || !Number.isInteger(killAt) || killAt < 1) {
    console.error('usage: scheduler-snapshot-mcp-fault-child <scenario> <dir> <kill-before|kill-after> <K>');
    process.exit(2);
  }
  const last = killAt + 3;
  if (scenario === 'scheduler') {
    installSyncRenameKill(mode, killAt, 'scheduled_tasks.json');
    for (let seq = 1; seq <= last; seq += 1) {
      writeScheduledTasksFile(path.join(dir, 'scheduled_tasks.json'), payloadFor(seq));
      ack(String(seq));
    }
  } else if (scenario === 'snapshot') {
    const store = createWorkspaceIdeSnapshotStore({ rootDir: dir });
    installAsyncRenameKill(mode, killAt, '.snap');
    for (let seq = 1; seq <= last; seq += 1) {
      const result = await store.capture({ content: snapshotContentFor(seq) });
      ack(`${seq} ${result.hash}`);
    }
  } else if (scenario === 'mcp-update') {
    const store = new McpConfigStore({ userDataPath: dir });
    installSyncRenameKill(mode, killAt, 'mcp-servers.json');
    for (let seq = 1; seq <= last; seq += 1) {
      const result = store.update(mcpAddServer(seq));
      if (!result.ok) throw new Error(`update ${seq} failed: ${result.reason}`);
      ack(String(seq));
    }
  } else {
    installSyncRenameKill(mode, killAt, 'mcp-servers.json');
    new McpConfigStore({ userDataPath: dir });
  }
  process.exit(0);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error?.stack || error);
    process.exit(3);
  });
}

module.exports = { FIXED_NOW, mcpAddServer, mcpServerFor, payloadFor, snapshotContentFor };
