// Real terminal stdin for the Python headless subprocess permission tests.
'use strict';
const pty = require('@lydell/node-pty');
const [python, config, answer] = process.argv.slice(2);
const child = pty.spawn(python, ['-m', 'sidecar', '--prompt', 'TTY probe',
  '--config', config, '--dangerously-skip-permissions', '--output-format', 'json'], {
  name: 'xterm-color', cols: 240, rows: 40, cwd: process.cwd(), env: process.env,
});
let output = '';
let answered = false;
const timer = setTimeout(() => {
  process.stderr.write(JSON.stringify({ output, answered }));
  child.kill();
  process.exit(1);
}, 15000);
child.onData(data => {
  output += data;
  if (data.includes('\x1b[6n')) child.write('\x1b[1;1R');
  if (!answered && output.includes('Continue in dangerously-skip mode?')) {
    answered = true;
    child.write(answer + '\r');
  }
});
child.onExit(({ exitCode }) => {
  clearTimeout(timer);
  process.stdout.write(JSON.stringify({ output: output.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, ''), exitCode }));
  process.exit(0);
});
