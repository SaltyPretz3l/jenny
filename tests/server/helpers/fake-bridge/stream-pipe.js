'use strict';

// Joins a transport stream to a loopback TCP socket, both directions, with
// backpressure (pipe() pauses a source while its destination is full).
// Closing or failing either end closes the other; a clean half-close lets the
// other direction finish flushing first.

function joinStreamAndSocket(stream, socket, onDone) {
  let finished = false;

  const settle = () => {
    if (finished) return;
    if (stream.destroyed && socket.destroyed) {
      finished = true;
      onDone();
    }
  };

  const destroyBoth = () => {
    if (!stream.destroyed) stream.destroy();
    if (!socket.destroyed) socket.destroy();
  };

  stream.on('error', destroyBoth);
  socket.on('error', destroyBoth);
  stream.on('close', () => {
    // A closed stream cannot carry more bytes either way.
    if (!socket.destroyed) socket.destroy();
    settle();
  });
  socket.on('close', () => {
    stream.unpipe(socket);
    if (stream.destroyed) {
      settle();
      return;
    }
    if (socket.errored) {
      stream.destroy();
      settle();
      return;
    }
    // The socket ended cleanly: let bytes already read reach the peer, then close.
    if (stream.writableFinished) {
      stream.destroy();
      return;
    }
    stream.once('finish', () => stream.destroy());
    if (!stream.writableEnded) stream.end();
    stream.resume();
  });

  stream.pipe(socket);
  socket.pipe(stream);
}

module.exports = { joinStreamAndSocket };
