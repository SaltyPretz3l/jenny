'use strict';

// Mirrors sidecar/ai/tools/plan_artifact_policy.py at the application authority
// boundary. Model-supplied capability flags never grant this exception.
const FAMILIES = { '.md': 'markdown', '.markdown': 'markdown', '.txt': 'text',
  '.mmd': 'mermaid', '.mermaid': 'mermaid', '.json': 'json', '.yaml': 'yaml',
  '.yml': 'yaml', '.csv': 'csv' };
const LANGUAGES = { md: 'markdown', markdown: 'markdown', plain: 'text',
  plain_text: 'text', plaintext: 'text', text: 'text', txt: 'text',
  mermaid: 'mermaid', mmd: 'mermaid', json: 'json', yaml: 'yaml', yml: 'yaml', csv: 'csv' };
const MAX_BYTES = 512 * 1024;

function textBytes(value) {
  return typeof value === 'string' && value.isWellFormed() ? Buffer.byteLength(value, 'utf8') : null;
}

// Full content, or (revisions only) well-formed edits whose replacement text
// fits the cap; the handler re-checks the revised file against the same limit.
function boundedPayload(args) {
  if (!Object.hasOwn(args, 'edits')) {
    const size = textBytes(args.content);
    return size !== null && size <= MAX_BYTES;
  }
  if (Object.hasOwn(args, 'content') || !Object.hasOwn(args, 'replaces')
    || !Array.isArray(args.edits) || !args.edits.length) return false;
  let total = 0;
  for (const item of args.edits) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return false;
    const newSize = textBytes(item.new_string);
    if (textBytes(item.old_string) === null || newSize === null) return false;
    total += newSize;
  }
  return total <= MAX_BYTES;
}

function suffixOf(name) {
  const filename = name.trim().replace(/\\/g, '/').split('/').pop();
  const dot = filename.lastIndexOf('.');
  return dot > 0 && dot < filename.length - 1 ? filename.slice(dot).toLowerCase() : '';
}

function safeDocument(args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)
    || String(args.artifact_kind || '').trim().toLowerCase() !== 'document'
    || typeof args.title !== 'string' || !args.title.trim()
    || !boundedPayload(args)) return false;
  const fields = ['language', 'extension', 'file_name'];
  if (fields.some(key => args[key] !== undefined && typeof args[key] !== 'string')) return false;
  // A revision is classified by the replaced file's own suffix, which must be inert.
  const revising = Object.hasOwn(args, 'replaces');
  if (revising && typeof args.replaces !== 'string') return false;
  const replacedSuffix = revising ? suffixOf(args.replaces) : '';
  if (revising && !replacedSuffix) return false;
  const language = (args.language || '').trim().toLowerCase().replace(/[- ]/g, '_');
  const rawExtension = (args.extension || '').trim().toLowerCase();
  const extension = rawExtension && (rawExtension.startsWith('.') ? rawExtension : `.${rawExtension}`);
  const suffix = suffixOf(args.file_name || '');
  if ((language && !Object.hasOwn(LANGUAGES, language))
    || (extension && !Object.hasOwn(FAMILIES, extension))
    || (suffix && !Object.hasOwn(FAMILIES, suffix))
    || (replacedSuffix && !Object.hasOwn(FAMILIES, replacedSuffix))) return false;
  return new Set([LANGUAGES[language], FAMILIES[extension], FAMILIES[suffix], FAMILIES[replacedSuffix]]
    .filter(Boolean)).size <= 1;
}

function allowsPlanArtifact(descriptor, args) {
  // The todo list is in-memory session state, never a workspace write. Plan
  // Mode may add a memory; correcting or forgetting one waits for the build.
  return descriptor.plan_mode_artifact_write === true
    && (descriptor.name === 'mermaid_generate' || descriptor.name === 'todo_write'
      || (descriptor.name === 'memory' && !!args && args.action === 'remember')
      || (descriptor.name === 'create_artifact' && safeDocument(args)));
}

module.exports = { allowsPlanArtifact, isSafeDocument: safeDocument };
