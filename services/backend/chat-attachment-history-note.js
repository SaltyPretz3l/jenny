'use strict';

// A replayed user row carries only its text: the files the user attached to it
// (images, text files, audio) went to the model on that turn and are not sent
// again. Without a note the model then claims nothing was ever attached
// (LFM3 image chat findings F2, 2026-11-13). This names each earlier
// attachment and its kind on the replayed row, so the model can say it cannot
// see the file again instead of denying it exists. Kind-agnostic on purpose:
// any later attachment kind is named from its metadata with no change here.

const MAX_NAMED_ATTACHMENTS = 8;
const MAX_NAME_CHARS = 80;

const KIND_LABELS = Object.freeze({ text: 'text file' });

function attachmentLabel(entry) {
  const name = String(entry?.displayName || '').replace(/\s+/g, ' ').trim() || 'attachment';
  const shortName = name.length > MAX_NAME_CHARS ? `${name.slice(0, MAX_NAME_CHARS - 1)}…` : name;
  const kind = String(entry?.kind || 'text').trim().toLowerCase() || 'text';
  return `${shortName} (${KIND_LABELS[kind] || kind})`;
}

function attachmentHistoryNote(attachments) {
  const list = Array.isArray(attachments) ? attachments.filter((entry) => entry && typeof entry === 'object') : [];
  if (!list.length) return '';
  const named = list.slice(0, MAX_NAMED_ATTACHMENTS).map(attachmentLabel);
  const more = list.length - named.length;
  const names = more > 0 ? `${named.join(', ')} and ${more} more` : named.join(', ');
  return `[Attached to this message earlier, not shown again: ${names}]`;
}

// Plain user rows only: kinded rows (recaps, session mail) and assistant rows
// (generated images) keep their content as it is.
function projectUserAttachmentNote(message, content) {
  if (message?.role !== 'user' || String(message.kind || '').trim()) return content;
  const note = attachmentHistoryNote(message.attachments);
  if (!note) return content;
  return content ? `${content}\n\n${note}` : note;
}

module.exports = { attachmentHistoryNote, projectUserAttachmentNote };
