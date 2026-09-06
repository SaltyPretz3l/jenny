const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { ShellConfigService } = require('../services/shell-config-service');
const { SkillsService } = require('../services/skills-service');
const {
  cleanupTrackedResources,
  trackDirectory,
} = require('./helpers/resource-cleanup');

test.afterEach(async () => {
  await cleanupTrackedResources();
});

test('bundled verification skill is discoverable with the expected metadata', () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-verification-skill-'));
  trackDirectory(userDataPath);

  const configService = new ShellConfigService({ userDataPath });
  const service = new SkillsService({
    configService,
    bundledRoot: path.join(process.cwd(), 'skills'),
    homedir: () => userDataPath,
    featureEnabled: true,
    watchIntervalMs: 0,
  });

  const state = service.getState();
  const entry = state.entries.find((item) => item.relPath === path.join('verification-specialist', 'SKILL.md'));

  assert.ok(entry);
  assert.equal(entry.name, 'Verification Specialist');
  assert.equal(entry.command, 'verify');
  assert.match(entry.description, /adversarially/i);
  assert.match(entry.whenToUse, /final PASS\/FAIL\/PARTIAL verdict/i);
  assert.deepEqual(entry.allowedTools, [
    'read_file',
    'glob_files',
    'grep_search',
    'git_status',
    'git_diff',
    'git_show',
    'workspace_change_baseline',
    'workspace_change_delta',
    'run_command',
    'web_search',
    'fetch_url',
  ]);
  const manifest = JSON.parse(
    fs.readFileSync(path.join(process.cwd(), 'services', 'tools', 'tool-manifest.json'), 'utf8')
  );
  const manifestToolNames = new Set((manifest.tools || []).map((tool) => tool.name));
  for (const toolName of entry.allowedTools) {
    assert.equal(manifestToolNames.has(toolName), true, `missing manifest entry for ${toolName}`);
  }
  // Discovery is metadata-only by contract (services/skills-service.js): the
  // trusted sidecar owns body loading after a source is explicitly enabled, so
  // getState() entries carry an empty body. Assert that contract here, then read
  // the bundled SKILL.md off disk for the body-content checks below.
  assert.equal(entry.body, '', 'discovery is metadata-only and does not carry the body');

  const body = fs.readFileSync(entry.realPath, 'utf8');
  assert.match(body, /ADVERSARIAL PROBES/);
  assert.match(body, /VERDICT: PASS/);
  assert.match(body, /exact runtime reason/i);
  assert.match(body, /expected_exit_codes/);
  assert.match(body, /git_show\(ref, path\)/);
  assert.match(body, /spawn UNKNOWN/);
  assert.match(body, /repository-local binaries invoked through `node`/);
  assert.match(body, /Treat remediation findings as hypotheses/);
});
