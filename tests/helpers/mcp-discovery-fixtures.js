'use strict';

// Shared fixtures for the McpDiscoveryService tests
// (tests/mcp-discovery-service*.test.js): a tracked temp userData directory,
// the mcp-servers.json writer, an approved-row builder and the rea preset row.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { configurationDigest } = require('../../services/mcp-config-store');
const { trackDirectory } = require('./resource-cleanup');

function userData() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-mcp-discovery-'));
  trackDirectory(directory);
  return directory;
}

function writeConfig(directory, servers, extra = {}) {
  fs.writeFileSync(path.join(directory, 'mcp-servers.json'), `${JSON.stringify({
    mcp_config_schema_version: 1, mcp_sse_enabled: false, mcp_servers: servers, ...extra,
  }, null, 2)}\n`, 'utf8');
}

function approvedServer(config, { enabled = true, toolsDigest = 'a'.repeat(64) } = {}) {
  return { ...config, enabled, trust: { status: 'approved',
    configuration_digest: configurationDigest(config), advertised_tools_digest: toolsDigest,
    advertised_prompts_digest: '',
    reviewed_at: '2026-08-17T00:00:00.000Z' } };
}

const REA_ROW = { name: 'rea', transport: 'stdio', command: 'npx', args: ['-y', 'rea-agents@6.4.0', 'mcp'],
  env: { REA_LOG_LEVEL: 'debug' }, memory_limit_mb: 2048, max_processes: 16,
  inspect_timeout_seconds: 90, request_timeout_seconds: 900 };

module.exports = { userData, writeConfig, approvedServer, REA_ROW };
