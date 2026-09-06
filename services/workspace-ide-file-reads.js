'use strict';

/* Bounded file reads for WorkspaceIdeService. Split out of
 * workspace-ide-service.js, which sits at the 1015-line ceiling -- the rule
 * there is to extract a cohesive block into a sibling rather than cram
 * statements onto one line to squeeze under it.
 *
 * Note for anyone extending this: services/versioned-workspace-file-bytes.js
 * owns the richer primitive (`readStableFileBytes`), which also detects a file
 * changing underneath the read. It is deliberately NOT used here, because it
 * reports a growing file as `changed_during_read` where this legacy path must
 * keep reporting the existing CMP-WORKSPACEFS too-large codes. */
// Reads at most `maxBytes + 1` bytes through a single handle. The extra byte is
// the whole point: it is enough to prove the file is over the cap without
// reading an unbounded amount of it. Callers compare against the bytes returned
// rather than a stat taken earlier, because a file that is being appended to --
// an ordinary log -- can grow between the two.
async function readCappedFile(fsImpl, realPath, maxBytes) {
  const handle = await fsImpl.open(realPath, 'r');
  try {
    const bytes = Buffer.alloc(Math.floor(maxBytes) + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!bytesRead) {
        break;
      }
      offset += bytesRead;
    }
    return bytes.subarray(0, offset);
  } finally {
    await handle.close();
  }
}

module.exports = {
  readCappedFile,
};
