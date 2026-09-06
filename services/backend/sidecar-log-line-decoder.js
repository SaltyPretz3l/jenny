const { StringDecoder } = require('node:string_decoder');

const DEFAULT_MAX_LINE_BYTES = 16 * 1024;

class SidecarLogLineDecoder {
  constructor({ maxLineBytes = DEFAULT_MAX_LINE_BYTES } = {}) {
    this.decoder = new StringDecoder('utf8');
    this.buffer = '';
    this.maxLineBytes = Math.max(1024, Number(maxLineBytes) || DEFAULT_MAX_LINE_BYTES);
    this.droppedOversizedLines = 0;
    this.discardingOversizedLine = false;
  }

  push(chunk) {
    this.buffer += this.decoder.write(Buffer.from(chunk || ''));
    return this._drain(false);
  }

  end(chunk) {
    if (chunk) this.buffer += this.decoder.end(Buffer.from(chunk));
    else this.buffer += this.decoder.end();
    return this._drain(true);
  }

  _drain(includePartial) {
    const lines = [];
    if (this.discardingOversizedLine) {
      const discardedLineEnd = this.buffer.indexOf('\n');
      if (discardedLineEnd < 0) {
        this.buffer = '';
        if (includePartial) this.discardingOversizedLine = false;
        return lines;
      }
      this.buffer = this.buffer.slice(discardedLineEnd + 1);
      this.discardingOversizedLine = false;
    }
    let newlineIndex = this.buffer.indexOf('\n');
    while (newlineIndex >= 0) {
      const line = this.buffer.slice(0, newlineIndex).replace(/\r$/, '');
      this.buffer = this.buffer.slice(newlineIndex + 1);
      this._appendBounded(lines, line);
      newlineIndex = this.buffer.indexOf('\n');
    }
    if (includePartial && this.buffer) {
      this._appendBounded(lines, this.buffer.replace(/\r$/, ''));
      this.buffer = '';
    } else if (Buffer.byteLength(this.buffer, 'utf8') > this.maxLineBytes) {
      this.buffer = '';
      this.droppedOversizedLines += 1;
      this.discardingOversizedLine = true;
    }
    return lines;
  }

  _appendBounded(lines, line) {
    if (!String(line || '').trim()) return;
    if (Buffer.byteLength(line, 'utf8') > this.maxLineBytes) {
      this.droppedOversizedLines += 1;
      return;
    }
    lines.push(line);
  }
}

module.exports = {
  DEFAULT_MAX_LINE_BYTES,
  SidecarLogLineDecoder,
};
