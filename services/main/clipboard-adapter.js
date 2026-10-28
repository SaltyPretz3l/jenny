'use strict';

// Electron 44 made main-process clipboard writes Promise-based W3C Clipboard
// calls and removed writeImage. This keeps the two writes the main process uses.
function createClipboardAdapter({ clipboard, ClipboardItem }) {
  return {
    async writeText(text) {
      await clipboard.writeText(text);
    },
    async writeImage(image) {
      const png = new Blob([image.toPNG()], { type: 'image/png' });
      await clipboard.write([new ClipboardItem({ 'image/png': png })]);
    },
  };
}

module.exports = { createClipboardAdapter };
