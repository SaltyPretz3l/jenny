'use strict';

// A chat that another chat starts through an accepted New session proposal (a plain child or a fork)
// begins with the tool switches its parent has at launch, Browser included: the parent asked for the
// work with those tools on, so a child that silently lost them could not do it (owner report
// 2026-11-10, a browser test spawned from Jenny primary started with Browser off). A person's own new
// chat still follows new-chat-browser-seed.js.

const { normalizeToolCategoryOverrides } = require('./session-normalizers');

/** The parent's tool category switches, normalized; {} when the parent is unknown or has none. */
function inheritedToolCategoryOverrides(store, parentSessionId) {
  if (typeof parentSessionId !== 'string' || !parentSessionId) return {};
  const parent = store?.peekSession?.(parentSessionId);
  return normalizeToolCategoryOverrides(parent?.tool_category_overrides);
}

module.exports = { inheritedToolCategoryOverrides };
