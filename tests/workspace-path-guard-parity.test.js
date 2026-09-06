'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const {
  buildAdapters,
  CASES,
  NAME_CASES,
} = require('./helpers/path-guard-parity-cases');

async function realpathForMissing(targetPath) {
  let current = targetPath;
  const trailing = [];
  while (current !== path.dirname(current)) {
    try {
      let resolved = await fs.realpath(current);
      for (let index = trailing.length - 1; index >= 0; index -= 1) {
        resolved = path.join(resolved, trailing[index]);
      }
      return resolved;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      trailing.push(path.basename(current));
      current = path.dirname(current);
    }
  }
  return path.resolve(targetPath);
}

for (const nameCase of NAME_CASES) {
  test(`strict name: ${nameCase.id}`, async (t) => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'jenny-path-name-root-'));
    t.after(() => fs.rm(rootDir, { recursive: true, force: true }));
    const adapter = buildAdapters({ rootDir })
      .find((candidate) => candidate.name === 'ide-path-guard');
    assert.ok(adapter, 'missing adapter ide-path-guard');

    const outcome = await adapter.resolve(nameCase.candidate);
    assert.equal(
      outcome.allowed ? 'allow' : 'reject',
      nameCase.expected['ide-path-guard'],
      `${nameCase.id}/ide-path-guard: ${outcome.reason || outcome.normalized}`
    );
  });
}

function comparable(targetPath) {
  const resolved = path.resolve(targetPath);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function assertInside(rootReal, targetReal, message) {
  const rootComparable = comparable(rootReal);
  const targetComparable = comparable(targetReal);
  const prefix = rootComparable.endsWith(path.sep)
    ? rootComparable
    : `${rootComparable}${path.sep}`;
  assert.ok(targetComparable === rootComparable || targetComparable.startsWith(prefix), message);
}

function assertOutside(rootReal, targetReal, message) {
  const rootComparable = comparable(rootReal);
  const targetComparable = comparable(targetReal);
  const prefix = rootComparable.endsWith(path.sep)
    ? rootComparable
    : `${rootComparable}${path.sep}`;
  assert.ok(targetComparable !== rootComparable && !targetComparable.startsWith(prefix), message);
}

for (const parityCase of CASES) {
  test(parityCase.id, async (t) => {
    for (const adapterName of ['tool-path-policy', 'root-operation', 'versioned-file', 'workspace-import']) {
      await t.test(adapterName, async (t) => {
        if (parityCase.win32Only && process.platform !== 'win32') {
          t.skip('Win32-only path algebra');
          return;
        }

        const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'jenny-path-parity-root-'));
        const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), 'jenny-path-parity-outside-'));
        t.after(async () => {
          await fs.rm(rootDir, { recursive: true, force: true });
          await fs.rm(outsideDir, { recursive: true, force: true });
        });

        const fixture = await parityCase.setup(rootDir, outsideDir);
        if (fixture && typeof fixture === 'object' && typeof fixture.skip === 'string') {
          t.skip(fixture.skip);
          return;
        }

        const adapter = buildAdapters({ rootDir })
          .find((candidate) => candidate.name === adapterName);
        assert.ok(adapter, `missing adapter ${adapterName}`);

        const outcome = await adapter.resolve(fixture);
        assert.equal(typeof outcome?.allowed, 'boolean', 'adapter must return a normalized outcome');

        if (outcome.allowed) {
          assert.equal(typeof outcome.realPath, 'string', 'allowed outcomes require realPath');
          const [rootReal, targetReal] = await Promise.all([
            fs.realpath(rootDir),
            realpathForMissing(outcome.realPath),
          ]);
          if (parityCase.expectedEscape?.includes(adapterName)) {
            assert.equal(outcome.postMutationEscape, true, 'adapter must report the observed escape');
            assertOutside(
              rootReal,
              targetReal,
              `${parityCase.id}/${adapterName} did not reproduce the expected escape: ${targetReal}`
            );
          } else {
            assertInside(
              rootReal,
              targetReal,
              `${parityCase.id}/${adapterName} escaped the workspace: ${targetReal}`
            );
          }
        }

        const expected = parityCase.expected[adapterName];
        assert.ok(expected, `missing expectation for ${adapterName}`);
        if (expected !== 'reject_or_allow') {
          assert.equal(
            outcome.allowed ? 'allow' : 'reject',
            expected,
            `${parityCase.id}/${adapterName}: ${outcome.reason || outcome.realPath}`
          );
        }
      });
    }
  });
}
