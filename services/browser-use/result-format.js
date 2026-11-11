'use strict';

/**
 * What the model reads back from the browser (roadmap row 114): each result as
 * text, and the short step summary saved to the chat in place of the page.
 */

const MAX_STEP_SUMMARY_CHARS = 300;
const MAX_SUMMARY_TITLE_CHARS = 80;
const MAX_SUMMARY_URL_CHARS = 160;
const READ_STATUS = 'ok';
const PAGE_WORDS = ['No', 'One', 'Two', 'Three', 'Four', 'Five'];

function tooManyPagesMessage(maxPages) {
  const count = PAGE_WORDS[maxPages] || String(maxPages);
  const verb = maxPages === 1 ? 'page is' : 'pages are';
  return `${count} browser ${verb} already in use in other chats. Try again when one is free.`;
}

/** `message` is saved to the chat, so anything read from the page belongs in `detail`, which only the model sees. */
function fail(status, message, detail) {
  return { ok: false, status, message, ...(detail ? { detail } : {}) };
}

function renderMatch({ ref, role, name, snippet }) {
  if (!ref) return String(snippet ?? '');
  return `[${ref}] ${role} "${name}": ${snippet}`;
}

function renderMatches(result) {
  const lines = [result.message, ...result.matches.map(renderMatch)];
  if (result.total > result.matches.length) {
    lines.push(`Showing the first ${result.matches.length}. Narrow the search for the rest.`);
  }
  return lines.join('\n');
}

/** The text the model reads back for one step. */
function formatForModel(result) {
  if (Array.isArray(result.matches)) return renderMatches(result);
  const message = result.detail ? `${result.message} ${result.detail}` : result.message;
  const outline = result.page?.text;
  if (!outline) return message;
  return result.status === READ_STATUS ? outline : `${message}\n\n${outline}`;
}

function oneLine(text, maxChars) {
  return String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, maxChars);
}

/**
 * What the chat keeps for one step: what happened and where. Page text and
 * find snippets stay out, so exports, transcripts and memory search never hold them.
 */
function stepSummary(result) {
  const message = oneLine(result.message, MAX_STEP_SUMMARY_CHARS);
  const page = result.page;
  if (!page?.url) return message;
  const title = oneLine(page.title, MAX_SUMMARY_TITLE_CHARS);
  const where = `Now on ${title ? `${title} ` : ''}(${oneLine(page.url, MAX_SUMMARY_URL_CHARS)})`;
  return oneLine(`${message} ${where}`, MAX_STEP_SUMMARY_CHARS);
}

module.exports = {
  fail,
  formatForModel,
  stepSummary,
  tooManyPagesMessage,
};
