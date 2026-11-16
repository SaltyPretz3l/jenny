'use strict';

/* The team export's two file formats, built in main from the one document the renderer gathered (row 123,
 * slice 2a-6c; renderer/team/renderer-team-export.js sends it through `dialog.saveFile`, and
 * services/save-file-handler.js builds only the format whose type was picked).
 *
 * The document is checked field by field and rebuilt: anything not in the shape below is dropped, and a
 * document past MAX_TEXT_CHARS of text is refused before anything is built (the caller says "Export failed.
 * Try again."). The words come localized from the renderer (`words`), the dates are formatted here with the
 * renderer's language tag.
 *
 * Markdown is the approved screen: a heading per conversation, one line of facts, a heading per day, each
 * message as "**sender** time" with its text below, replies quoted under it. Nothing written can pass for that
 * structure: a name loses its line breaks and has `*`, `#` and `\` escaped (a conversation's name after "# "
 * keeps its `#`, which cannot start a heading there); a line of message text that would
 * start a heading, a sender line or a quote gets a leading backslash (inside a reply's quote too). A deleted
 * message is kept only while it has replies, as one line in the app's words ("Message deleted by {name}"); its
 * text never reaches the document. JSON is the shape decided for the slice; a deleted root carries
 * `deleted: true` and an empty text. */

const MAX_TEXT_CHARS = 32 * 1024 * 1024; // about 64 MiB of UTF-16; the built file is bounded the same way
const MAX_CONVERSATIONS = 1000;
const FIELD_MAX = 400;

const str = (value, max = FIELD_MAX) => (typeof value === 'string' ? value.slice(0, max) : '');
const fill = (template, values) => String(template).replace(/\{(\w+)\}/g, (match, name) => (Object.prototype.hasOwnProperty.call(values, name) ? String(values[name]) : match));

// One message (and, at the top level, its replies). Returns null for anything that is not one.
function readMessage(raw, withReplies, budget) {
  if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string') return null;
  const text = raw.deleted === true ? '' : (typeof raw.text === 'string' ? raw.text : '');
  budget.chars += text.length;
  const message = { id: str(raw.id, 64), sender: str(raw.sender), sent_at: str(raw.sent_at, 40), edited: raw.edited === true, text };
  if (raw.deleted === true) { message.deleted = true; message.deleted_by = str(raw.deleted_by); }
  if (withReplies) message.replies = (Array.isArray(raw.replies) ? raw.replies : []).map((r) => readMessage(r, false, budget)).filter(Boolean);
  return message;
}

// The renderer's document, rebuilt; null when it is not one or is past the bound.
function readDocument(raw) {
  if (!raw || typeof raw !== 'object' || raw.kind !== 'team-export' || !Array.isArray(raw.conversations) || raw.conversations.length > MAX_CONVERSATIONS) return null;
  const budget = { chars: 0 };
  const words = raw.words && typeof raw.words === 'object' ? raw.words : {};
  const doc = {
    team: str(raw.team), exportedBy: str(raw.exportedBy), exportedAt: Number.isFinite(raw.exportedAt) ? raw.exportedAt : Date.now(),
    locale: /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(String(raw.locale || '')) ? raw.locale : undefined,
    words: { edited: str(words.edited, 80), facts: str(words.facts), deleted: str(words.deleted) },
    conversations: [],
  };
  for (const c of raw.conversations) {
    if (!c || typeof c !== 'object') continue;
    doc.conversations.push({ name: str(c.name), kind: c.kind === 'direct' ? 'direct' : 'channel',
      messages: (Array.isArray(c.messages) ? c.messages : []).map((m) => readMessage(m, true, budget)).filter(Boolean) });
    if (budget.chars > MAX_TEXT_CHARS) return null;
  }
  return doc;
}

function formatters(locale, timeZone) {
  const opts = (extra) => Object.assign(timeZone ? { timeZone } : {}, extra);
  return {
    day: new Intl.DateTimeFormat(locale, opts({ day: 'numeric', month: 'long', year: 'numeric' })),
    time: new Intl.DateTimeFormat(locale, opts({ hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })),
    stamp: new Intl.DateTimeFormat(locale, opts({ day: 'numeric', month: 'short', year: 'numeric' })),
  };
}

// A name on one line, with nothing that Markdown reads as emphasis or a heading.
const nameText = (name) => String(name).replace(/\s+/g, ' ').trim().replace(/[\\*#]/g, (c) => '\\' + c);
// A conversation's name after "# ": one line, no emphasis; its own "#" (a channel) cannot start a heading there.
const headingText = (name) => String(name).replace(/\s+/g, ' ').trim().replace(/[\\*]/g, (c) => '\\' + c);
// A line of message text that would start a heading, a sender line or a quote reads as plain text.
const textLine = (line) => (/^\s{0,3}(#|\*\*|>)/.test(line) ? '\\' + line : line);
const count = (messages) => messages.reduce((n, m) => n + (m.deleted ? 0 : 1) + m.replies.length, 0);

function buildMarkdown(doc, { timeZone } = {}) {
  const f = formatters(doc.locale, timeZone);
  const exported = new Date(doc.exportedAt);
  const stamp = f.stamp.format(exported) + ' ' + f.time.format(exported);
  const head = (m) => '**' + nameText(m.sender) + '** ' + f.time.format(new Date(m.sent_at)) + (m.edited ? doc.words.edited : '');
  const body = (m) => (m.deleted ? [fill(doc.words.deleted, { name: m.deleted_by }).replace(/\s+/g, ' ')].map(textLine) : String(m.text).split(/\r?\n/).map(textLine));
  const sections = doc.conversations.map((c) => {
    const lines = ['# ' + headingText(c.name), '', fill(doc.words.facts, { team: doc.team, when: stamp, you: doc.exportedBy, count: count(c.messages).toLocaleString(doc.locale) })];
    let day = '';
    for (const m of c.messages) {
      const today = f.day.format(new Date(m.sent_at));
      if (today !== day) { day = today; lines.push('', '## ' + day); }
      lines.push('', ...(m.deleted ? [] : [head(m)]), ...body(m));
      if (m.replies.length) {
        lines.push('');
        m.replies.forEach((r, i) => {
          if (i) lines.push('>');
          lines.push('> ' + head(r), ...body(r).map((line) => (line ? '> ' + line : '>')));
        });
      }
    }
    return lines.join('\n') + '\n';
  });
  return sections.join('\n');
}

function buildJson(doc) {
  const message = (m, withReplies) => Object.assign({ id: m.id, sender: m.sender, sent_at: m.sent_at, edited: m.edited, text: m.text },
    m.deleted ? { deleted: true } : {}, withReplies ? { replies: m.replies.map((r) => message(r, false)) } : {});
  return JSON.stringify({ team: doc.team, exported_at: new Date(doc.exportedAt).toISOString(), exported_by: doc.exportedBy,
    conversations: doc.conversations.map((c) => ({ name: c.name, kind: c.kind, messages: c.messages.map((m) => message(m, true)) })) }, null, 2) + '\n';
}

// The text of one format, or null past the bound (the caller refuses the save).
function buildFormat(doc, format) {
  const text = format === 'json' ? buildJson(doc) : buildMarkdown(doc);
  return text.length > MAX_TEXT_CHARS * 2 ? null : text;
}

module.exports = { MAX_TEXT_CHARS, readDocument, buildMarkdown, buildJson, buildFormat };
