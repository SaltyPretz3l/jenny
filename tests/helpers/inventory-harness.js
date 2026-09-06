/*
 * tests/helpers/inventory-harness.js
 *
 * Shared setup for tests that exercise renderers depending on
 * global.inventory (the badge / spinner / collapsible / codeblock
 * primitive bag wired in production by renderer/shell/renderer-bootstrap-dom.js).
 *
 * `withInventory(t)` installs a fresh inventory bag for the duration of
 * one test and restores the previous value via t.after(). It returns the
 * installed bag so tests that need to swap individual primitives (e.g.
 * inject a stub Collapsible) can mutate it in place.
 */

const badge = require('../../renderer/inventory/badge');
const spinner = require('../../renderer/inventory/spinner');
const Collapsible = require('../../renderer/inventory/collapsible');
const CodeBlock = require('../../renderer/inventory/codeblock');

function withInventory(t, overrides) {
  const previousInventory = global.inventory;
  t.after(() => {
    global.inventory = previousInventory;
  });
  const inventory = Object.assign(
    { badge, spinner, collapsible: Collapsible, codeBlock: CodeBlock },
    overrides || {}
  );
  global.inventory = inventory;
  return inventory;
}

module.exports = {
  withInventory,
  badge,
  spinner,
  Collapsible,
  CodeBlock,
};
