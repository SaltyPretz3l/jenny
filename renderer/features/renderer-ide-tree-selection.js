/* renderer/features/renderer-ide-tree-selection.js - Explorer selection state. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererIdeTreeSelection = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function createIdeTreeSelection() {
    const paths = new Set();
    let anchor = '';

    function getPaths() {
      return [...paths];
    }

    function replace(nextPaths, anchorPath) {
      paths.clear();
      for (const path of Array.isArray(nextPaths) ? nextPaths : []) {
        paths.add(path);
      }
      anchor = anchorPath || '';
    }

    function toggle(path) {
      if (paths.has(path)) {
        paths.delete(path);
      } else {
        paths.add(path);
      }
      anchor = path;
    }

    function extendRange(orderedPaths, toPath) {
      const fromIndex = orderedPaths.indexOf(anchor);
      const toIndex = orderedPaths.indexOf(toPath);
      if (fromIndex === -1 || toIndex === -1) {
        replace([toPath], toPath);
        return;
      }
      const start = Math.min(fromIndex, toIndex);
      const end = Math.max(fromIndex, toIndex);
      replace(orderedPaths.slice(start, end + 1), anchor);
    }

    function selectAll(orderedPaths) {
      replace(orderedPaths, orderedPaths[0] || '');
    }

    function clear() {
      paths.clear();
      anchor = '';
    }

    function dropPath(path) {
      const prefix = `${path}/`;
      for (const member of paths) {
        if (member === path || member.startsWith(prefix)) {
          paths.delete(member);
        }
      }
      if (anchor === path || anchor.startsWith(prefix)) {
        anchor = '';
      }
    }

    function remapPath(fromPath, toPath) {
      const prefix = `${fromPath}/`;
      const remapped = getPaths().map((member) => {
        if (member === fromPath) return toPath;
        return member.startsWith(prefix) ? `${toPath}/${member.slice(prefix.length)}` : member;
      });
      paths.clear();
      for (const member of remapped) paths.add(member);
      if (anchor === fromPath) {
        anchor = toPath;
      } else if (anchor.startsWith(prefix)) {
        anchor = `${toPath}/${anchor.slice(prefix.length)}`;
      }
    }

    function resolveTargets(focusedPath) {
      return paths.size ? getPaths() : focusedPath ? [focusedPath] : [];
    }

    return {
      has: (path) => paths.has(path),
      size: () => paths.size,
      getPaths,
      replace,
      toggle,
      extendRange,
      selectAll,
      clear,
      dropPath,
      remapPath,
      resolveTargets,
    };
  }

  return { createIdeTreeSelection };
});
