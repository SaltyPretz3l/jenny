'use strict';

// Recognises a command that keeps running until someone stops it: a dev server, a file
// watcher or a follow. Run on a command card waits for the command to finish, so such a
// command would block the turn until its timeout; the card keeps Copy only and the model is
// told to start it in the background instead. Pure and conservative: a miss leaves Run on,
// as before, and a hit costs only the Run button (Copy always works).

// A tool name counts only where a command starts (line start, after ; & | or a subshell
// paren, or through npx/bunx), so `npm install -D vite` or `pip install uvicorn` stay Run-able.
const AT = String.raw`(?:^|[;&|(]\s*)(?:(?:npx|bunx|pnpm\s+exec|pnpm\s+dlx)\s+)?`;
const at = (body) => new RegExp(AT + body, 'i');

const PATTERNS = Object.freeze([
  // Package-manager scripts that serve or watch: npm run dev, pnpm start, yarn serve, bun run watch.
  at(String.raw`(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:dev|start|serve|watch|preview)(?![:\w-])`),
  // Python servers.
  at(String.raw`(?:python[0-9.]*|py)(?:\.exe)?\s+(?:-[a-zA-Z0-9.]+\s+)*-m\s+(?:http\.server|SimpleHTTPServer|uvicorn|flask\s+run)\b`),
  at(String.raw`(?:uvicorn|gunicorn|hypercorn|daphne)\s+\S`),
  at(String.raw`(?:python[0-9.]*\s+)?manage\.py\s+runserver\b`),
  at(String.raw`jupyter(?:-|\s+)(?:notebook|lab|server)\b`),
  at(String.raw`(?:flask|streamlit)\s+run\b`),
  // Node and front-end dev servers.
  at(String.raw`(?:nodemon|live-server|http-server|webpack-dev-server|browser-sync)\b`),
  at(String.raw`(?:next|nuxt|astro|remix|gatsby|svelte-kit)\s+dev\b`),
  at(String.raw`(?:ng|webpack|mkdocs)\s+serve\b`),
  at(String.raw`php\s+artisan\s+serve\b`),
  at(String.raw`vite(?:\s+(?:dev|serve|preview))?(?=\s*$|\s+-)`),
  at(String.raw`serve(?:\s|$)`),
  // Other ecosystems.
  at(String.raw`php\s+-S\s`),
  at(String.raw`(?:bundle\s+exec\s+)?rails\s+(?:s|server)\b`),
  at(String.raw`(?:hugo|jekyll)\s+serve(?:r)?\b`),
  at(String.raw`(?:cargo|dotnet)\s+watch\b`),
  at(String.raw`docker(?:-compose|\s+compose)\s+up\b(?!.*\s(?:-d|--detach|--wait|--abort-on-container-exit|--exit-code-from)\b)`),
  // Watch flags and follows, wherever they sit (--watch=false and --watch=0 finish).
  /(?:^|\s)--watch(?:\s|$|=(?!false\b|0\b))/i,
  /\btsc\b.*\s-w(?:\s|$)/i,
  /\btail\b.*\s(?:-[a-zA-Z]*f|--follow)\b/i,
  /\bGet-Content\b.*\s-Wait\b/i,
  /\bping\b(?!.*\s-[cn]\s).*\s-t\b/i,
]);

// Asking a tool about itself finishes at once.
const SELF_QUERY = /(?:^|\s)(?:--version|--help|-V)(?:\s|$)/;
// Quoted text is an argument (a commit message, a grep pattern), never the command itself.
const QUOTED = /"(?:[^"\\]|\\.)*"|'[^']*'/g;
const MAX_SCAN_CHARS = 4096;

/** True when *command* looks like it keeps running until stopped (a server, watcher or follow). */
function looksLongRunning(command) {
  if (typeof command !== 'string') return false;
  const text = command.slice(0, MAX_SCAN_CHARS).replace(QUOTED, '""');
  if (SELF_QUERY.test(text)) return false;
  return PATTERNS.some((pattern) => pattern.test(text));
}

module.exports = { looksLongRunning };
