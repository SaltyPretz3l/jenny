#!/usr/bin/env node
/* global process */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import checksModule from './validate/plugin-source-checks.js';
import digestWriter from './validate/plugin-digest-writer.js';
import loader from './validate/plugin-source-loader.js';
import report from './validate/plugin-source-report.js';

const { runChecks } = checksModule;
const { writeDigests } = digestWriter;
const { loadPluginSource } = loader;
const { formatJson, formatText } = report;

function parseArgs(argv) {
  const flags = new Set();
  const targets = [];
  for (const arg of argv) {
    if (arg === '--json' || arg === '--write-digests') flags.add(arg);
    else if (arg.startsWith('-')) throw Object.assign(new Error(`unknown option: ${arg}`), {
      code: 'target_unusable',
    });
    else targets.push(arg);
  }
  if (targets.length !== 1) throw Object.assign(new Error('provide exactly one plugin folder or archive'), {
    code: 'target_unusable',
  });
  return { target: targets[0], json: flags.has('--json'), write: flags.has('--write-digests') };
}

export async function validatePluginCli(argv) {
  let options;
  try {
    options = parseArgs(argv);
    let source = await loadPluginSource(options.target);
    if (options.write) {
      if (source.kind !== 'folder') throw Object.assign(
        new Error('--write-digests is available only for plugin folders'), { code: 'target_unusable' }
      );
      writeDigests(source);
      if (!options.json) {
        process.stdout.write('note: plugin.json rewritten with current digests (formatting normalized)\n');
      }
      source = await loadPluginSource(options.target);
    }
    const checked = await runChecks(source);
    const summary = checked.checks.reduce((counts, check) => {
      counts[check.status === 'pass' ? 'passed' : check.status === 'fail' ? 'failed' : 'skipped'] += 1;
      return counts;
    }, { passed: 0, failed: 0, skipped: 0 });
    const result = {
      ok: checked.ok,
      target: source.rootPath,
      target_kind: source.kind,
      checks: checked.checks,
      summary,
    };
    process.stdout.write(options.json ? formatJson(result) : formatText(result));
    return result.ok ? 0 : 1;
  } catch (error) {
    process.stderr.write(`error: ${error?.message || 'target is unusable'}\n`);
    return 2;
  }
}

if (path.resolve(process.argv[1] || '') === path.resolve(fileURLToPath(import.meta.url))) {
  process.exitCode = await validatePluginCli(process.argv.slice(2));
}
