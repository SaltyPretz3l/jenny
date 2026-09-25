'use strict';

// Mirrors sidecar/ai/tools/plan_artifact_policy.py at the application authority
// boundary. Model-supplied capability flags never grant this exception.
const FAMILIES = { '.md': 'markdown', '.markdown': 'markdown', '.txt': 'text',
  '.mmd': 'mermaid', '.mermaid': 'mermaid', '.json': 'json', '.yaml': 'yaml',
  '.yml': 'yaml', '.csv': 'csv' };
const LANGUAGES = { md: 'markdown', markdown: 'markdown', plain: 'text',
  plain_text: 'text', plaintext: 'text', text: 'text', txt: 'text',
  mermaid: 'mermaid', mmd: 'mermaid', json: 'json', yaml: 'yaml', yml: 'yaml', csv: 'csv' };

function safeDocument(args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)
    || String(args.artifact_kind || '').trim().toLowerCase() !== 'document'
    || typeof args.title !== 'string' || !args.title.trim()
    || typeof args.content !== 'string' || !args.content.isWellFormed()
    || Buffer.byteLength(args.content, 'utf8') > 512 * 1024) return false;
  const fields = ['language', 'extension', 'file_name'];
  if (fields.some(key => args[key] !== undefined && typeof args[key] !== 'string')) return false;
  const language = (args.language || '').trim().toLowerCase().replace(/[- ]/g, '_');
  const rawExtension = (args.extension || '').trim().toLowerCase();
  const extension = rawExtension && (rawExtension.startsWith('.') ? rawExtension : `.${rawExtension}`);
  const filename = (args.file_name || '').trim().replace(/\\/g, '/').split('/').pop();
  const dot = filename.lastIndexOf('.');
  const suffix = dot > 0 && dot < filename.length - 1 ? filename.slice(dot).toLowerCase() : '';
  if ((language && !Object.hasOwn(LANGUAGES, language))
    || (extension && !Object.hasOwn(FAMILIES, extension))
    || (suffix && !Object.hasOwn(FAMILIES, suffix))) return false;
  return new Set([LANGUAGES[language], FAMILIES[extension], FAMILIES[suffix]].filter(Boolean)).size <= 1;
}

function allowsPlanArtifact(descriptor, args) {
  // The todo list is in-memory session state, never a workspace write.
  return descriptor.plan_mode_artifact_write === true
    && (descriptor.name === 'mermaid_generate' || descriptor.name === 'todo_write'
      || (descriptor.name === 'create_artifact' && safeDocument(args)));
}

module.exports = { allowsPlanArtifact, isSafeDocument: safeDocument };
