#!/usr/bin/env node
// Dev launcher that opts INTO the default-off internal TASK_CAPSULE feature
// flag for hands-on testing, then delegates to start.js. The flag is in
// INTERNAL_FEATURE_FLAG_KEYS (no Settings UI toggle), so the JENNY_ENABLE_*
// env override is its intended opt-in path. Setting it here (and only here)
// keeps `npm run dev` byte-identical to the shipped defaults.
//
// Usage:
//   node scripts/dev/dev-test-flags.js            (or: npm run dev:test-flags)
//   node scripts/dev/dev-test-flags.js --agent    (extra args pass through)
//
// To stop testing these, just launch the app the normal way (`npm run dev`).

const path = require('path');
const { spawn } = require('child_process');

// This entry flips the default-off flag ON. The key mirrors the
// JENNY_ENABLE_<KEY> name read by services/feature-flags.js.
const TEST_FLAGS = ['JENNY_ENABLE_TASK_CAPSULE'];

const env = { ...process.env };
for (const key of TEST_FLAGS) {
  env[key] = '1';
}

console.log('Jenny dev launch with test feature flags ON:');
for (const key of TEST_FLAGS) {
  console.log(`  ${key}=1`);
}

const startJs = path.join(__dirname, '..', '..', 'start.js');
const child = spawn(process.execPath, [startJs, ...process.argv.slice(2)], {
  stdio: 'inherit',
  env,
  cwd: path.join(__dirname, '..', '..'),
});

child.on('error', (error) => {
  console.error(`dev-test-flags failed to launch start.js: ${String((error && error.message) || error)}`);
  process.exit(1);
});
child.on('close', (code) => {
  process.exit(code ?? 0);
});
