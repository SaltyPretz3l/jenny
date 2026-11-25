'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { looksLongRunning } = require('../services/backend/long-running-command');

test('servers, watchers and follows are recognised', () => {
  for (const command of [
    'python -m http.server 8766', 'python3 -m http.server', 'py -3 -m http.server 8000',
    'npm run dev', 'pnpm dev', 'yarn start', 'bun run watch', 'npm start', 'npx vite', 'vite --port 3000',
    'uvicorn app:main --reload', 'flask run', 'python manage.py runserver', 'jupyter lab',
    'nodemon server.js', 'npx http-server .', 'next dev', 'ng serve', 'php -S localhost:8000',
    'rails s', 'hugo server', 'cargo watch -x run', 'docker compose up', 'tsc -w', 'jest --watch',
    'tail -f log.txt', 'Get-Content app.log -Wait', 'ping -t 127.0.0.1', 'npx serve dist', 'cd web && npm run dev',
    'tail -n 20 -f log.txt', 'jest --watch=true', '(cd site && hugo server)', 'php artisan serve',
  ]) {
    assert.equal(looksLongRunning(command), true, command);
  }
});

test('commands that finish are not flagged', () => {
  for (const command of [
    'npm test', 'npm run build', 'npm run dev:check', 'npm run start-report', 'vite build', 'npx vite build',
    'python -m pytest', 'python script.py', 'docker compose up -d', 'docker compose up --detach web',
    'cargo build --features serve', 'git status', 'tail -n 20 log.txt', 'ping 127.0.0.1', 'tsc -p .',
    // Review 2026-11-19: installs, quoted mentions, self-queries and flags that finish.
    'npm install -D vite', 'npm i -g http-server', 'pnpm add -D nodemon', 'pip install uvicorn fastapi',
    'pip install jupyter notebook', 'uvicorn --version', 'vite --version', 'python -m http.server --help',
    'git commit -m "document npm start script"', "grep -rn 'npm run dev' docs",
    'ng test --watch=false --browsers=ChromeHeadless', 'vitest run --watch=false',
    'docker compose up --wait', 'docker compose up --abort-on-container-exit', 'ping -c 4 -t 64 host',
  ]) {
    assert.equal(looksLongRunning(command), false, command);
  }
  assert.equal(looksLongRunning(null), false);
  assert.equal(looksLongRunning(42), false);
});
