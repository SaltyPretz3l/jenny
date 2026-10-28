'use strict';

// Child process for shell-config-faults.test.js (rows C1/C2).
// Usage: node <this> <profile dir> <kill-before|kill-after> <K>
//
// Builds a ShellConfigService on the profile, then performs saves. Save N sets
// the assistant name to a pure function of N. A test-only wrapper around
// fs.renameSync SIGKILLs this process on the Kth rename whose destination is
// shell-config.json: before the real rename (kill-before) or right after it
// returned (kill-after). A synchronous ack line is written after each save
// returned, so every acked value was durable before the kill. If the loop ends
// without the kill firing, the child exits 0 and the test fails on that.

const fs = require('node:fs');
const path = require('node:path');

const { ShellConfigService } = require('../../services/shell-config-service');

const FIXED_NOW = new Date('2026-10-26T00:00:00.000Z');

function agentNameFor(seq) {
  return `agent-${seq}`;
}

function createService(userDataPath, logger = null) {
  return new ShellConfigService({
    userDataPath,
    env: {},
    logger,
    nowProvider: () => FIXED_NOW,
  });
}

function saveStep(service, seq) {
  service.updateAssistantIdentity({ agentName: agentNameFor(seq) });
}

function installRenameKill(mode, killAt) {
  const realRename = fs.renameSync;
  let shellConfigRenames = 0;
  fs.renameSync = function renameWithKill(from, to, ...rest) {
    if (path.basename(String(to)) !== 'shell-config.json') return realRename.call(this, from, to, ...rest);
    shellConfigRenames += 1;
    if (shellConfigRenames !== killAt) return realRename.call(this, from, to, ...rest);
    if (mode === 'kill-before') process.kill(process.pid, 'SIGKILL');
    const result = realRename.call(this, from, to, ...rest);
    process.kill(process.pid, 'SIGKILL');
    return result;
  };
}

function main() {
  const [profileDir, mode, killAtText] = process.argv.slice(2);
  const killAt = Number(killAtText);
  if (!profileDir || !['kill-before', 'kill-after'].includes(mode) || !Number.isInteger(killAt) || killAt < 1) {
    console.error('usage: shell-config-fault-child <profile dir> <kill-before|kill-after> <K>');
    process.exit(2);
  }
  const service = createService(profileDir);
  installRenameKill(mode, killAt);
  for (let seq = 1; seq <= killAt + 3; seq += 1) {
    saveStep(service, seq);
    fs.writeSync(1, `${seq}\n`);
  }
  process.exit(0);
}

if (require.main === module) main();

module.exports = { FIXED_NOW, agentNameFor, createService, saveStep };
