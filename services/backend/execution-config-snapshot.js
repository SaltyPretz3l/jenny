'use strict';

const MAX_KNOWLEDGE_ROOTS = 32;
const MAX_KNOWLEDGE_ROOT_CHARS = 4096;

// The bounded knowledge-root list a turn's execution context carries.
function normalizeKnowledgeRoots(config) {
  const roots = Array.isArray(config?.knowledge_roots) ? config.knowledge_roots : [];
  if (roots.length > MAX_KNOWLEDGE_ROOTS) throw new Error('Knowledge root snapshot exceeds its bound.');
  return roots.map((value) => {
    const root = typeof value === 'string' ? value.trim() : '';
    if (!root || root.length > MAX_KNOWLEDGE_ROOT_CHARS) {
      throw new Error('Knowledge root snapshot contains an invalid path.');
    }
    return root;
  });
}

module.exports = { normalizeKnowledgeRoots };
