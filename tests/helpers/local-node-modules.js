'use strict';

// A few cases read files of installed packages by path under <repo>/node_modules (what the
// packaged app ships, the vendor stylesheet, the jsdom bundle the runner builds). A worktree
// nested inside another checkout can have no node_modules of its own: `require` still finds
// every package in the parent checkout, so the rest of the suite runs, but those paths are not
// there. Such a case skips with the reason below instead of failing on a missing file.
//
// A gate run (JENNY_REQUIRE_PYTHON_TESTS=1, set by scripts/checks/run_ci.py) does not skip: a
// gate that cannot check what gets packaged has to fail, the same rule as the missing venv.

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');

function withoutLocalInstall(packages) {
  if (process.env.JENNY_REQUIRE_PYTHON_TESTS === '1') return false;
  const missing = packages.find((name) => !fs.existsSync(path.join(ROOT, 'node_modules', name, 'package.json')));
  if (!missing) return false;
  return `this checkout has no node_modules/${missing} of its own (packages resolve from a parent checkout); run "npm ci" here to run this case`;
}

module.exports = { withoutLocalInstall };
